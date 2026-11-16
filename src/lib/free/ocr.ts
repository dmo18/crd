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

/**
 * Where a line came from: the whole photo ("page"), a wide colored band such
 * as a name or team banner ("band"), or an upright strip at the photo's left
 * or right edge ("edge"). The parser may trust a band line as a headline.
 */
export type OcrSource = "page" | "band" | "edge";
export type OcrLine = { text: string; confidence: number; box: Box; source?: OcrSource };
export type OcrResult = {
  text: string;
  lines: OcrLine[];
  confidence: number;
  /** How many reading passes the photo took. For tests and timing only. */
  passes?: number;
};
export type ReadOptions = {
  /**
   * Box labels and bulk boxes: always add the automatic layout pass and keep
   * every distinct line from all passes, since labels mix big and small text.
   */
  thorough?: boolean;
  /**
   * Many cards from one photo: no band or edge passes, so a big sheet stays
   * inside the scan's time limit on the slow server (at most 6 passes).
   */
  quick?: boolean;
};
export interface TextReader {
  read(image: Buffer, options?: ReadOptions): Promise<OcrResult>;
}

const LONG_EDGE = 1800;
const JOB_TIMEOUT_MS = 60_000;
/** Below this (confidence times characters) a third, automatic layout pass is tried. */
const LITTLE_TEXT_SCORE = 12;
/**
 * Below this the photo may be sideways (many 1980s backs are printed across
 * the long side), so the photo is also read turned a quarter each way.
 */
const SIDEWAYS_SCORE = 60;
/** Text read across the grain comes back as low confidence gibberish, so a low average also counts. */
const SIDEWAYS_CONFIDENCE = 0.55;
/** Most reading passes for one card photo, band and edge passes included. */
export const MAX_PASSES = 9;
/** Most passes for a card cut from a many-card photo (`quick`). */
export const QUICK_PASSES = 6;
/** Most reading passes for one box label or bulk box photo (thorough mode). */
const MAX_THOROUGH_PASSES = 6;
/** Wide colored bands read on their own, at most this many per photo. */
const MAX_BANDS = 3;
/** A band is cut out and enlarged (or shrunk) to this height before reading. */
const BAND_HEIGHT = 160;
/** White border added around a band before reading. */
const BAND_MARGIN = 20;
/** Share of the photo's width cut from each side for the edge pass. */
const EDGE_SHARE = 0.09;
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

/** The same picture turned 90 or 270 degrees clockwise. */
async function turned(v: Variant, angle: 90 | 270): Promise<Variant> {
  const png = await sharp(v.png).rotate(angle).png().toBuffer();
  return { png, width: v.height, height: v.width };
}

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

/** Color class of a pixel: 0 is dark, 1 to 12 are hues of strong color, -1 is light or gray. */
function colorClass(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 80) return 0;
  const sat = (max - min) / max;
  if (sat < 0.4 || max < 90) return -1;
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  return 1 + (Math.floor(hue * 2) % 12);
}

/** Dark matches only dark; a hue also matches its two neighbors, so an orange band is one band. */
function sameClass(c: number, band: number): boolean {
  if (c < 0) return false;
  if (band === 0 || c === 0) return c === band;
  const d = Math.abs(c - band);
  return d <= 1 || d === 11;
}

/** A band found in a photo: its box in fractions, and whether it is dark or which color. */
export type Band = { box: Box; dark: boolean; color: number };

/**
 * Wide bands of one strong color or dark with lettering inside, such as a
 * team banner, a name strip or a dark header on a card back. Best first, at
 * most `max`. A band is at least 40% of the photo's width and 4% to 22% of
 * its height.
 */
export async function findBands(image: Buffer, max = MAX_BANDS): Promise<Band[]> {
  const SIZE = 240;
  const { data, info } = await sharp(image, DECODE_OPTIONS)
    .rotate()
    .removeAlpha()
    .resize(SIZE, SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const cls = new Int8Array(w * h);
  for (let i = 0; i < w * h; i++) cls[i] = colorClass(data[i * channels], data[i * channels + 1], data[i * channels + 2]);

  const found: { band: Band; score: number }[] = [];
  for (let band = 0; band <= 12; band++) {
    const rowShare = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (sameClass(cls[y * w + x], band)) n++;
      rowShare[y] = n / w;
    }
    let y = 0;
    while (y < h) {
      if (rowShare[y] < 0.25) {
        y++;
        continue;
      }
      // A run of rows, allowing one weak row inside (a thin letter stroke line).
      const top = y;
      let bottom = y;
      while (bottom + 1 < h && (rowShare[bottom + 1] >= 0.25 || (bottom + 2 < h && rowShare[bottom + 2] >= 0.25))) bottom++;
      y = bottom + 1;
      const bh = bottom - top + 1;
      if (bh < h * 0.04 || bh > h * 0.22) continue;
      // Columns that are mostly the band color give its left and right ends.
      let left = -1;
      let right = -1;
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let yy = top; yy <= bottom; yy++) if (sameClass(cls[yy * w + x], band)) n++;
        if (n / bh >= 0.5) {
          if (left < 0) left = x;
          right = x;
        }
      }
      if (left < 0 || right - left + 1 < w * 0.4) continue;
      let inBand = 0;
      let other = 0;
      for (let yy = top; yy <= bottom; yy++) {
        for (let x = left; x <= right; x++) {
          const c = cls[yy * w + x];
          if (sameClass(c, band)) inBand++;
          // Lettering contrasts with the band: light on dark, or dark or light on a color.
          else if (band === 0 ? c !== 0 : c === 0 || c === -1) other++;
        }
      }
      const area = bh * (right - left + 1);
      const fill = inBand / area;
      const ink = other / area;
      if (fill < 0.5 || ink < 0.06 || ink > 0.5) continue;
      found.push({
        band: { box: { x: left / w, y: top / h, w: (right - left + 1) / w, h: bh / h }, dark: band === 0, color: band },
        score: fill * ((right - left + 1) / w),
      });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const out: Band[] = [];
  for (const f of found) {
    // The same band can show up for two colors (a dark band with colored letters); keep it once.
    const b = f.band.box;
    const overlaps = out.some(({ box: o }) => Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y) > 0.5 * Math.min(o.h, b.h));
    if (!overlaps) out.push(f.band);
    if (out.length >= max) break;
  }
  return out;
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
  const maxPasses = options.quick ? QUICK_PASSES : MAX_PASSES;
  const variants = await preprocess(image);
  let best: OcrLine[] = [];
  let bestScore = -1;
  let bestVariant = variants[0];
  for (const v of variants) {
    const page = await recognizeOnce(v.png);
    const lines = linesFrom(page, v.width, v.height);
    const s = score(lines);
    if (s > bestScore) {
      best = lines;
      bestScore = s;
      bestVariant = v;
    }
  }
  if (options.thorough) {
    const v = variants[0];
    const all = [...best, ...linesFrom(await recognizeOnce(v.png, PSM.AUTO), v.width, v.height)];
    // At most 3 labels, so one photo costs no more than 6 reading passes.
    for (const region of await findLabelRegions(image, MAX_THOROUGH_PASSES - 3)) {
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
  let passes = variants.length;
  let turn: Turn = 0;
  if (bestScore < LITTLE_TEXT_SCORE) {
    const v = variants[0];
    const lines = linesFrom(await recognizeOnce(v.png, PSM.AUTO), v.width, v.height);
    passes++;
    const s = score(lines);
    if (s > bestScore) {
      best = lines;
      bestScore = s;
    }
  }
  // Still little text: the card may be sideways. Read it turned both ways and
  // keep whichever reads best. Line boxes are then relative to the turned
  // picture, which is the card the right way up.
  if (bestScore < SIDEWAYS_SCORE || summarize(best).confidence < SIDEWAYS_CONFIDENCE) {
    for (const angle of [90, 270] as const) {
      if (passes >= maxPasses) break;
      const v = await turned(bestVariant, angle);
      const lines = linesFrom(await recognizeOnce(v.png), v.width, v.height);
      passes++;
      const s = score(lines);
      if (s > bestScore) {
        best = lines;
        bestScore = s;
        turn = angle;
      }
    }
  }
  // Band and edge passes add the lines they read to the best page read so
  // far, instead of competing with it: a headline read from a banner does
  // not make the rest of the card's text less useful.
  const merged: OcrLine[] = best.map((l) => ({ ...l, source: "page" }));
  const seen = new Set(merged.map((l) => lineKey(l.text)));
  const add = (lines: OcrLine[]) => {
    for (const l of lines) {
      const key = lineKey(l.text);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(l);
    }
  };
  let upright: Variant | null = null;
  // Quick reads (cards cut from a many-card photo) skip band and edge passes:
  // `upright` stays null, so the edge pass below is skipped too.
  if (!options.quick) try {
    upright = await colorUpright(image, turn);
    for (const band of await findBands(upright.png, MAX_BANDS)) {
      if (passes >= maxPasses) break;
      const read = await readBand(upright, band, maxPasses - passes);
      passes += read.passes;
      add(read.lines);
    }
  } catch {
    // A band that cannot be cut out is skipped; the page read still counts.
  }
  // The year on many backs stands only in tiny upright print by the edge.
  if (upright && !merged.some((l) => YEAR_RE.test(l.text))) {
    for (const side of ["right", "left"] as const) {
      if (passes >= maxPasses) break;
      try {
        const lines = await readEdge(upright, side);
        passes++;
        add(lines);
      } catch {
        // Same as a band: skipped.
      }
    }
  }
  return { ...summarize(merged), passes };
}

type Turn = 0 | 90 | 270;
const YEAR_RE = /(?:^|[^0-9])(?:19|20)\d{2}(?![0-9])/;

function lineKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The photo in color, the right way up, at the same size the page passes read. */
async function colorUpright(image: Buffer, turn: Turn): Promise<Variant> {
  let pipe = sharp(await sharp(image, DECODE_OPTIONS).rotate().toBuffer());
  if (turn) pipe = sharp(await pipe.rotate(turn).toBuffer());
  const { data, info } = await pipe
    .removeAlpha()
    .resize(LONG_EDGE, LONG_EDGE, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** Pixels of the photo inside a box given in fractions, never outside the photo. */
function pixelBox(v: Variant, box: Box): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(box.x * v.width));
  const top = Math.max(0, Math.floor(box.y * v.height));
  const width = Math.min(v.width - left, Math.round(box.w * v.width));
  const height = Math.min(v.height - top, Math.round(box.h * v.height));
  return { left, top, width, height };
}

/**
 * Dark letters on white from a map of ink pixels. Ink above or below the band
 * is kept only where it joins ink inside the band (the top of a tall letter),
 * so a frame line or a bit of photo next to the band does not confuse the reader.
 */
function keepLetters(ink: Uint8Array, width: number, coreTop: number, coreBottom: number): Buffer {
  const out = Buffer.alloc(ink.length, 255);
  const stack: number[] = [];
  for (let i = coreTop * width; i < (coreBottom + 1) * width; i++) {
    if (ink[i] !== 1) continue;
    ink[i] = 2;
    stack.push(i);
  }
  while (stack.length) {
    const i = stack.pop()!;
    out[i] = 0;
    const x = i % width;
    const next = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const n of next) {
      if (n >= 0 && n < ink.length && ink[n] === 1) {
        ink[n] = 2;
        stack.push(n);
      }
    }
  }
  return out;
}

/** A box in the picture with BAND_MARGIN added, as a box in the picture without it. */
function unmargin(b: Box, width: number, height: number): Box {
  const W = width + 2 * BAND_MARGIN;
  const H = height + 2 * BAND_MARGIN;
  const x0 = clamp01((b.x * W - BAND_MARGIN) / width);
  const y0 = clamp01((b.y * H - BAND_MARGIN) / height);
  const x1 = clamp01(((b.x + b.w) * W - BAND_MARGIN) / width);
  const y1 = clamp01(((b.y + b.h) * H - BAND_MARGIN) / height);
  return { x: x0, y: y0, w: Math.max(0.001, x1 - x0), h: Math.max(0.001, y1 - y0) };
}

/** Lines read from a band, and how many reading passes that took. */
type BandRead = { lines: OcrLine[]; passes: number };

/** A band read is good enough when one line came back with this confidence. */
const BAND_GOOD = 0.6;

/**
 * One band read as a single line: cut out, sized to BAND_HEIGHT, the color
 * channel with the most contrast, black and white at the Otsu level, dark
 * letters on light. Which side is the letters is a guess from the border
 * (the background touches it most); when that read is weak and `spare`
 * allows a second pass, the other way round is read too and the better
 * read is kept. Zero passes when the band is too small to read.
 */
async function readBand(photo: Variant, found: Band, spare: number): Promise<BandRead> {
  const band = found.box;
  // Room above and below: a band found on a small copy can clip tall letters.
  const padY = band.h * 0.1;
  const top = Math.max(0, band.y - padY);
  const box = { x: band.x, y: top, w: band.w, h: Math.min(1 - top, band.h + 2 * padY) };
  const px = pixelBox(photo, box);
  if (spare < 1 || px.width < 16 || px.height < 8) return { lines: [], passes: 0 };
  const rgb = await sharp(photo.png).extract(px).resize({ height: BAND_HEIGHT }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = rgb.info;
  // The band itself, without the room above and below, sets the channel, the
  // level and which way round the letters are.
  const coreTop = Math.max(0, Math.floor(((band.y - box.y) / box.h) * height));
  const coreBottom = Math.min(height - 1, Math.ceil(((band.y + band.h - box.y) / box.h) * height));
  let channel = 0;
  let bestSpread = -1;
  for (let c = 0; c < Math.min(3, channels); c++) {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let i = coreTop * width; i < (coreBottom + 1) * width; i++) {
      const v = rgb.data[i * channels + c];
      sum += v;
      sq += v * v;
      n++;
    }
    const spread = n ? sq / n - (sum / n) ** 2 : 0;
    if (spread > bestSpread) {
      bestSpread = spread;
      channel = c;
    }
  }
  const plane = Buffer.alloc(width * height);
  for (let i = 0; i < plane.length; i++) plane[i] = rgb.data[i * channels + channel];
  const level = otsuThreshold(plane.subarray(coreTop * width, (coreBottom + 1) * width));
  let edge = 0;
  let edgeDark = 0;
  for (let y = coreTop; y <= coreBottom; y++) {
    for (let x = 0; x < width; x++) {
      if (x > 1 && x < width - 2 && y > coreTop + 1 && y < coreBottom - 1) continue;
      edge++;
      if (plane[y * width + x] <= level) edgeDark++;
    }
  }
  const readAs = async (flip: boolean): Promise<OcrLine[]> => {
    const ink = new Uint8Array(plane.length);
    for (let i = 0; i < plane.length; i++) ink[i] = plane[i] > level === flip ? 1 : 0;
    // A white margin all round: the reader finds letters that touch the picture's edge poorly.
    const png = await sharp(keepLetters(ink, width, coreTop, coreBottom), { raw: { width, height, channels: 1 } })
      .extend({ top: BAND_MARGIN, bottom: BAND_MARGIN, left: BAND_MARGIN, right: BAND_MARGIN, background: "#ffffff" })
      .png()
      .toBuffer();
    const lines = linesFrom(await recognizeOnce(png, PSM.SINGLE_LINE), width + 2 * BAND_MARGIN, height + 2 * BAND_MARGIN);
    // Boxes come back relative to the picture with its margin; make them relative to the crop.
    return lines.map((l) => ({ ...l, box: unmargin(l.box, width, height) }));
  };
  // A dark band has light letters: flip it. For a colored band, the letters
  // may be darker or lighter; the border is mostly background, so a mostly
  // dark border means light letters.
  const flip = found.dark || edgeDark > edge / 2;
  let lines = await readAs(flip);
  let passes = 1;
  if (spare >= 2 && !lines.some((l) => l.confidence >= BAND_GOOD)) {
    const other = await readAs(!flip);
    passes++;
    if (score(other) > score(lines)) lines = other;
  }
  return {
    passes,
    lines: lines.map((l) => ({
      ...l,
      source: "band" as const,
      box: { x: box.x + l.box.x * box.w, y: box.y + l.box.y * box.h, w: l.box.w * box.w, h: l.box.h * box.h },
    })),
  };
}

/**
 * The right or left strip of the photo turned upright (print running up the
 * right edge or down the left edge), enlarged 2 times. Boxes are mapped back
 * onto the whole photo.
 */
async function readEdge(photo: Variant, side: "right" | "left"): Promise<OcrLine[]> {
  const strip = { x: side === "right" ? 1 - EDGE_SHARE : 0, y: 0, w: EDGE_SHARE, h: 1 };
  const px = pixelBox(photo, strip);
  const angle = side === "right" ? 90 : 270;
  const { data, info } = await sharp(await sharp(photo.png).extract(px).grayscale().toBuffer())
    .rotate(angle)
    .resize({ width: px.height * 2 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const lines = linesFrom(await recognizeOnce(data), info.width, info.height);
  return lines.map((l) => {
    // Turned 90 clockwise, a point (u, v) of the strip came from (v, 1 - u); turned 270, from (1 - v, u).
    const inStrip =
      side === "right"
        ? { x: l.box.y, y: 1 - (l.box.x + l.box.w), w: l.box.h, h: l.box.w }
        : { x: 1 - (l.box.y + l.box.h), y: l.box.x, w: l.box.h, h: l.box.w };
    return {
      ...l,
      source: "edge" as const,
      box: { x: strip.x + inStrip.x * strip.w, y: inStrip.y, w: inStrip.w * strip.w, h: inStrip.h },
    };
  });
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
