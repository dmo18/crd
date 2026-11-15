import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM, type Page, type Worker } from "tesseract.js";
import type { Box } from "@/lib/recognition/types";

/**
 * Reads printed text from card photos on the server, fully offline.
 * Uses tesseract.js with the English data bundled in @tesseract.js-data/eng,
 * so nothing is ever downloaded at runtime. Never logs image data or text.
 */

export type OcrLine = { text: string; confidence: number; box: Box };
export type OcrResult = { text: string; lines: OcrLine[]; confidence: number };
export type ReadOptions = {
  /**
   * Box labels and bulk boxes: always add the automatic layout pass and keep
   * every distinct line from all passes, since labels mix big and small text.
   */
  thorough?: boolean;
};
export interface TextReader {
  read(image: Buffer, options?: ReadOptions): Promise<OcrResult>;
}

const LONG_EDGE = 1800;
const JOB_TIMEOUT_MS = 60_000;
/** Below this (confidence times characters) a third, automatic layout pass is tried. */
const LITTLE_TEXT_SCORE = 12;
const MIN_LINE_CONFIDENCE = 0.3;
const MIN_LINE_CHARS = 2;
const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;

type ReaderState = {
  worker: Promise<Worker> | null;
  queue: Promise<unknown>;
};

const STATE_KEY = Symbol.for("crd.free.ocr");
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: ReaderState };

function state(): ReaderState {
  const g = globalThis as GlobalWithState;
  if (!g[STATE_KEY]) g[STATE_KEY] = { worker: null, queue: Promise.resolve() };
  return g[STATE_KEY];
}

/** Absolute path to the bundled English data folder. Resolved from the app folder. */
function langPath(): string {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const pkg = req.resolve("@tesseract.js-data/eng/package.json");
  return path.join(path.dirname(pkg), "4.0.0_best_int");
}

async function startWorker(): Promise<Worker> {
  // Starting the engine reads local files only; it should never take long.
  const worker = await withTimeout(createWorker("eng", 1, {
    langPath: langPath(),
    gzip: true,
    cacheMethod: "none",
    errorHandler: () => {
      // Errors also reject the job that caused them; the worker is replaced then.
    },
  }), JOB_TIMEOUT_MS);
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  return worker;
}

function getWorker(): Promise<Worker> {
  const s = state();
  if (!s.worker) {
    const created = startWorker();
    s.worker = created;
    created.catch(() => {
      if (s.worker === created) s.worker = null;
    });
  }
  return s.worker;
}

async function dropWorker(): Promise<void> {
  const s = state();
  const current = s.worker;
  s.worker = null;
  if (!current) return;
  try {
    const worker = await current;
    await worker.terminate();
  } catch {
    // Already gone.
  }
}

/** Runs one job at a time. A failed job does not block the ones after it. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const s = state();
  const run = s.queue.then(job, job);
  s.queue = run.catch(() => undefined);
  return run;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Reading text took too long.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Variant = { png: Buffer; width: number; height: number };

/** Otsu's method: the gray level that best splits a histogram into dark and light. */
export function otsuThreshold(pixels: Uint8Array | Buffer): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of pixels) hist[v]++;
  const total = pixels.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumBack = 0;
  let weightBack = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/**
 * Two versions of the photo: plain grayscale, and black and white split at
 * the Otsu level. No contrast stretching or sharpening: on plain card
 * backgrounds those blow up photo noise until it drowns the text.
 */
async function preprocess(image: Buffer): Promise<Variant[]> {
  const base = sharp(image, DECODE_OPTIONS)
    .rotate()
    .grayscale()
    .resize(LONG_EDGE, LONG_EDGE, { fit: "inside", withoutEnlargement: false });
  const raw = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = raw.info;
  const gray = await sharp(raw.data, { raw: { width, height, channels: 1 } }).png().toBuffer();

  const level = otsuThreshold(raw.data);
  let dark = 0;
  for (const v of raw.data) if (v <= level) dark++;
  // Text is the smaller share of the card. When most pixels are dark the card
  // is light text on a dark background, so flip it to dark on light.
  let bw = sharp(raw.data, { raw: { width, height, channels: 1 } }).threshold(Math.max(1, level + 1));
  if (dark > raw.data.length / 2) bw = bw.negate({ alpha: false });
  const binary = await bw.png().toBuffer();

  return [
    { png: gray, width, height },
    { png: binary, width, height },
  ];
}

/**
 * Light, solid rectangles such as box labels and stickers, as boxes in
 * fractions. The text engine skips a label framed by a dark area, so these
 * are read on their own. At most `max` regions, largest first.
 */
export async function findLabelRegions(image: Buffer, max = 6): Promise<Box[]> {
  const SIZE = 400;
  const { data, info } = await sharp(image, DECODE_OPTIONS)
    .rotate()
    .grayscale()
    .resize(SIZE, SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const level = otsuThreshold(data);
  const seen = new Uint8Array(w * h);
  const regions: { box: Box; area: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || data[start] <= level) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const n of next) {
        if (n >= 0 && !seen[n] && data[n] > level) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const boxArea = bw * bh;
    // Solid enough to be a label (text holes lower the fill), not the whole photo, not a speck.
    if (boxArea < w * h * 0.01 || boxArea > w * h * 0.9) continue;
    if (area / boxArea < 0.6) continue;
    regions.push({ box: { x: minX / w, y: minY / h, w: bw / w, h: bh / h }, area: boxArea });
  }
  return regions.sort((a, b) => b.area - a.area).slice(0, max).map((r) => r.box);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function toBox(b: { x0: number; y0: number; x1: number; y1: number }, width: number, height: number): Box | null {
  const x = clamp01(b.x0 / width);
  const y = clamp01(b.y0 / height);
  const w = Math.min(1 - x, Math.max(0, (b.x1 - b.x0) / width));
  const h = Math.min(1 - y, Math.max(0, (b.y1 - b.y0) / height));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function linesFrom(page: Page, width: number, height: number): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = line.text.replace(/\s+/g, " ").trim();
        const signal = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
        const confidence = clamp01(line.confidence / 100);
        if (signal < MIN_LINE_CHARS || confidence < MIN_LINE_CONFIDENCE) continue;
        const box = toBox(line.bbox, width, height);
        if (!box) continue;
        out.push({ text, confidence, box });
      }
    }
  }
  return out;
}

function score(lines: OcrLine[]): number {
  return lines.reduce((sum, l) => sum + l.confidence * l.text.length, 0);
}

function summarize(lines: OcrLine[]): OcrResult {
  const chars = lines.reduce((sum, l) => sum + l.text.length, 0);
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    confidence: chars > 0 ? score(lines) / chars : 0,
  };
}

async function recognizeOnce(png: Buffer, mode: PSM = PSM.SPARSE_TEXT): Promise<Page> {
  const worker = await getWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: mode });
    const result = await withTimeout(worker.recognize(png, {}, { blocks: true, text: true }), JOB_TIMEOUT_MS);
    return result.data;
  } catch (cause) {
    await dropWorker();
    throw new Error("Could not read text from the photo.", { cause });
  }
}

async function readImage(image: Buffer, options: ReadOptions = {}): Promise<OcrResult> {
  const variants = await preprocess(image);
  let best: OcrLine[] = [];
  let bestScore = -1;
  for (const v of variants) {
    const page = await recognizeOnce(v.png);
    const lines = linesFrom(page, v.width, v.height);
    const s = score(lines);
    if (s > bestScore) {
      best = lines;
      bestScore = s;
    }
  }
  if (options.thorough) {
    const v = variants[0];
    const all = [...best, ...linesFrom(await recognizeOnce(v.png, PSM.AUTO), v.width, v.height)];
    // At most 3 labels, so one photo costs no more than 6 reading passes.
    for (const region of await findLabelRegions(image, 3)) {
      const left = Math.floor(region.x * v.width);
      const top = Math.floor(region.y * v.height);
      const width = Math.min(v.width - left, Math.round(region.w * v.width));
      const height = Math.min(v.height - top, Math.round(region.h * v.height));
      if (width < 16 || height < 16) continue;
      let crop: Buffer;
      try {
        crop = await sharp(v.png).extract({ left, top, width, height }).png().toBuffer();
      } catch {
        continue;
      }
      // Boxes come back relative to the crop; map them onto the whole photo.
      for (const line of linesFrom(await recognizeOnce(crop), width, height)) {
        all.push({
          ...line,
          box: {
            x: region.x + line.box.x * region.w,
            y: region.y + line.box.y * region.h,
            w: line.box.w * region.w,
            h: line.box.h * region.h,
          },
        });
      }
    }
    const seen = new Set<string>();
    const unique = all.filter((l) => {
      const key = l.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return summarize(unique);
  }
  // Sparse mode suits card backs with scattered text but can miss large
  // block lettering such as box labels. When little was read, also try
  // automatic page layout on the plain grayscale version.
  if (bestScore < LITTLE_TEXT_SCORE) {
    const v = variants[0];
    const lines = linesFrom(await recognizeOnce(v.png, PSM.AUTO), v.width, v.height);
    if (score(lines) > bestScore) best = lines;
  }
  return summarize(best);
}

const reader: TextReader = {
  read(image: Buffer, options?: ReadOptions): Promise<OcrResult> {
    return enqueue(() => readImage(image, options));
  },
};

export function getTextReader(): TextReader {
  return reader;
}

/** Stops the shared worker. The next read starts a fresh one. */
export async function closeTextReader(): Promise<void> {
  const s = state();
  await s.queue.catch(() => undefined);
  await dropWorker();
}
