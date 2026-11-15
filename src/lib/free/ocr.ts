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
export interface TextReader {
  read(image: Buffer): Promise<OcrResult>;
}

const LONG_EDGE = 1800;
const JOB_TIMEOUT_MS = 60_000;
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
  const worker = await createWorker("eng", 1, {
    langPath: langPath(),
    gzip: true,
    cacheMethod: "none",
    errorHandler: () => {
      // Errors also reject the job that caused them; the worker is replaced then.
    },
  });
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

/** Two versions of the photo: cleaned grayscale, and the same thresholded to black and white. */
async function preprocess(image: Buffer): Promise<Variant[]> {
  const gray = await sharp(image, DECODE_OPTIONS)
    .rotate()
    .grayscale()
    .normalise()
    .resize(LONG_EDGE, LONG_EDGE, { fit: "inside", withoutEnlargement: false })
    .sharpen({ sigma: 0.8 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = gray.info;

  const stats = await sharp(gray.data).stats();
  const mean = stats.channels[0]?.mean ?? 128;
  // Threshold at the image's own mean so glare and tinted backgrounds fall to one side.
  // Mostly dark images (light text on a dark card) are flipped so text ends up dark on light.
  let bw = sharp(gray.data).threshold(Math.min(250, Math.max(5, Math.round(mean))));
  if (mean < 128) bw = bw.negate({ alpha: false });
  const binary = await bw.png().toBuffer();

  return [
    { png: gray.data, width, height },
    { png: binary, width, height },
  ];
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

async function recognizeOnce(png: Buffer): Promise<Page> {
  const worker = await getWorker();
  try {
    const result = await withTimeout(worker.recognize(png, {}, { blocks: true, text: true }), JOB_TIMEOUT_MS);
    return result.data;
  } catch (cause) {
    await dropWorker();
    throw new Error("Could not read text from the photo.", { cause });
  }
}

async function readImage(image: Buffer): Promise<OcrResult> {
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
  return summarize(best);
}

const reader: TextReader = {
  read(image: Buffer): Promise<OcrResult> {
    return enqueue(() => readImage(image));
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
