import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Box, ReadFix } from "@/lib/recognition/types";
import { cornerBoxes, cropBox, findCard, joinSpacedLetters, keepCornerLine, mapBox, overlapShare, spacedBands, toView } from "./card-picture";
import { ReaderDownError, WorkerClient, type OcrEngine, type ReaderStatus, type WorkerLine, type WorkerRead } from "./ocr-worker";

/**
 * Reads printed text from card photos on the server, fully offline, with
 * RapidOCR (PP-OCR models on onnxruntime) in a Python worker started by the
 * app (see ocr-worker.ts and ocr/worker.py). The models are files in the
 * image, never downloaded at run time. Never logs image data or text.
 */

/**
 * Where a line came from: "page" the whole card, "band" a band of spaced
 * letters read again squeezed, "corner" a corner of a back read again larger.
 * "edge" was a pass of the old reader; the parser still accepts it.
 */
export type OcrSource = "page" | "band" | "edge" | "corner";
/**
 * One text box: its text, the reader's confidence (0 to 1) and where it sits
 * as fractions of the picture (the photo, or the photo turned upright when it
 * was read sideways).
 */
export type OcrLine = {
  text: string; confidence: number; box: Box; source?: OcrSource;
  /** The same text was read again, alone, by a second read of its spot (a corner re-read): two reads agree. */
  twice?: boolean;
};
export type OcrResult = {
  text: string;
  lines: OcrLine[];
  confidence: number;
  /** How many full reading passes the photo took (at most MAX_PASSES). For tests and timing only. */
  passes?: number;
  /** How many small re-reads (corners, spaced bands) came on top. For tests and timing only. */
  crops?: number;
  /** How to show the photo this was read from: its card box and the turn that makes it upright (S1b). */
  fix?: ReadFix;
};
export type ReadOptions = {
  /**
   * Box labels and bulk boxes. The reader finds labels inside dark frames on
   * its own, so this reads like a card photo without the sideways re-read.
   */
  thorough?: boolean;
  /** Many cards from one photo: one read only, no crop, no re-reads. */
  quick?: boolean;
  /** The back of a card: the corners are read again for the card number. */
  back?: boolean;
  /**
   * A card whose side is not known (many cards in one photo): asked once,
   * after the card is read the right way up, whether this is a back. When it
   * says yes the corners are read again as for `back`.
   */
  backIf?: (read: OcrResult) => boolean;
};
export interface TextReader {
  read(image: Buffer, options?: ReadOptions): Promise<OcrResult>;
}

/** Long edge of the picture sent to the reader (the size the trial measured). */
export const LONG_EDGE = 1200;
/** Most reading passes for one photo: the first read and one sideways re-read. */
export const MAX_PASSES = 2;
const MIN_LINE_CONFIDENCE = 0.3;
const MIN_LINE_CHARS = 2;
/** A box this much taller than wide holds text running up or down. */
const TALL = 1.5;
/** A photo is upside down when at least this share of its text was read turned over. */
const UPSIDE_DOWN_SHARE = 0.7;
/** The upright re-read of a sideways photo wins unless it scores below this share of the first read. */
const UPRIGHT_SHARE = 0.8;
/** The photo is kept at most this large for the crops (corners need the detail). */
const BASE_EDGE = 2400;
/** The card is cut out of the photo when it covers less than this share of it. */
const CROP_AREA = 0.85;
/** A cut out card is enlarged at most this much for its read. */
const MAX_UP = 2;
/** Corners are read at this long side, enlarged at most this much. */
const CORNER_EDGE = 640;
const CORNER_MAX_UP = 3;
/** Small parts are padded until their short side is at least this share of the long side. */
const PAD_SHARE = 0.5;
/** Spaced bands: at most this many, read this many pixels high, squeezed to these shares of their width. */
const MAX_BANDS = 2;
const BAND_HEIGHT = 96;
const BAND_SQUEEZES = [0.25, 0.33] as const;
const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;

const Settings = z.object({
  OCR_PYTHON: z.string().trim().min(1).max(1024).default("python3"),
  OCR_WORKER: z.string().trim().min(1).max(1024).optional(),
  OCR_MODELS_DIR: z.string().trim().max(1024).default(""),
  OCR_THREADS: z.coerce.number().int().min(1).max(8).default(4),
  OCR_IDLE_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
});

/** Where the reader's Python and worker are, from env settings (see .env.example). */
export function readerSettings(source: Record<string, string | undefined> = process.env) {
  const raw = Object.fromEntries(
    ["OCR_PYTHON", "OCR_WORKER", "OCR_MODELS_DIR", "OCR_THREADS", "OCR_IDLE_MINUTES"]
      .filter((k) => source[k] !== undefined && source[k]!.trim() !== "")
      .map((k) => [k, source[k]]),
  );
  const s = Settings.parse(raw);
  if (s.OCR_PYTHON.includes("\0") || (s.OCR_WORKER ?? "").includes("\0") || s.OCR_MODELS_DIR.includes("\0")) {
    throw new Error("Text reader settings must be plain paths.");
  }
  return {
    python: s.OCR_PYTHON,
    worker: path.resolve(s.OCR_WORKER ?? path.join(process.cwd(), "ocr", "worker.py")),
    modelsDir: s.OCR_MODELS_DIR ? path.resolve(s.OCR_MODELS_DIR) : "",
    threads: s.OCR_THREADS,
    idleMinutes: s.OCR_IDLE_MINUTES,
  };
}

/** The real worker, started on first use. */
export function pythonEngine(settings = readerSettings()): OcrEngine {
  return new WorkerClient({
    command: settings.python,
    // -I: ignore user site folders and PYTHON* settings; -B: write no .pyc files.
    args: ["-I", "-B", settings.worker],
    modelsDir: settings.modelsDir,
    threads: settings.threads,
    idleMs: settings.idleMinutes * 60_000,
  });
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The smallest upright box around four corner points, in fractions of the picture. */
export function boxOf(points: [number, number][], width: number, height: number): Box | null {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = clamp01(Math.min(...xs) / width);
  const y0 = clamp01(Math.min(...ys) / height);
  const x1 = clamp01(Math.max(...xs) / width);
  const y1 = clamp01(Math.max(...ys) / height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Lines of a read; `minChars` 1 keeps single letters (only to find spaced bands). */
function linesFrom(read: WorkerRead, minChars = MIN_LINE_CHARS): OcrLine[] {
  const out: OcrLine[] = [];
  for (const l of read.lines) {
    const text = joinSpacedLetters(l.text.replace(/\s+/g, " ").trim());
    const signal = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const confidence = clamp01(l.score);
    if (signal < minChars || confidence < MIN_LINE_CONFIDENCE) continue;
    const box = boxOf(l.box, read.width, read.height);
    if (!box) continue;
    out.push({ text, confidence, box, source: "page" });
  }
  return out;
}

function score(lines: OcrLine[]): number {
  return lines.reduce((sum, l) => sum + l.confidence * l.text.length, 0);
}

function summarize(lines: OcrLine[], passes: number, crops = 0): OcrResult {
  const chars = lines.reduce((sum, l) => sum + l.text.length, 0);
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    confidence: chars > 0 ? score(lines) / chars : 0,
    passes,
    crops,
  };
}

/**
 * Which way a sideways photo must turn (degrees clockwise) to stand upright,
 * or 0 when most of its text already runs across. The worker turns tall boxes
 * a quarter to the left before reading and says when it then also turned a
 * line upside down: such text runs up the photo (turn 90), other tall text
 * runs down it (turn 270). Text running across that was mostly turned over
 * means the photo is upside down (turn 180).
 */
export function sidewaysTurn(read: WorkerRead): 0 | 90 | 180 | 270 {
  return turnWithTrust(read).turn;
}

/** At least this many lines must agree on a direction, and this share of the weight, for the turn to be trusted. */
const TURN_MIN_LINES = 2;
const TURN_AGREE = 0.75;

/** The same turn, with whether enough text lines agree on it to act on it. */
export function turnWithTrust(read: WorkerRead): { turn: 0 | 90 | 180 | 270; trusted: boolean } {
  let across = 0;
  let acrossTurned = 0;
  let acrossTurnedLines = 0;
  let up = 0;
  let down = 0;
  let upLines = 0;
  let downLines = 0;
  for (const l of read.lines) {
    const xs = l.box.map((p) => p[0]);
    const ys = l.box.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const weight = l.text.replace(/\s/g, "").length * l.score;
    if (h >= TALL * w) {
      if (l.turned) { up += weight; upLines++; } else { down += weight; downLines++; }
    } else {
      across += weight;
      if (l.turned) { acrossTurned += weight; acrossTurnedLines++; }
    }
  }
  // Text running across but upside down (the worker turned most lines over):
  // the photo is upside down, so boxes sit mirrored from where they are on
  // the card (12R.5). Turned right round so corners and rows read right.
  if (up + down <= across) {
    if (across >= 4 && acrossTurned > UPSIDE_DOWN_SHARE * across) {
      return { turn: 180, trusted: acrossTurnedLines >= TURN_MIN_LINES };
    }
    return { turn: 0, trusted: true };
  }
  if (up + down < 4) return { turn: 0, trusted: false };
  const winner = up > down ? up : down;
  const lines = up > down ? upLines : downLines;
  return { turn: up > down ? 90 : 270, trusted: lines >= TURN_MIN_LINES && winner / (up + down) >= TURN_AGREE };
}

/** A picture sent to the reader; `inner` is where the part sits when it was padded. */
type Picture = { png: Buffer; width: number; height: number; inner?: Region };
type Region = { x: number; y: number; w: number; h: number };

/** The photo the right way up (camera orientation applied), white behind any see-through parts. */
async function oriented(image: Buffer): Promise<Buffer> {
  return sharp(image, DECODE_OPTIONS)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(BASE_EDGE, BASE_EDGE, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/**
 * A part of a picture (fractions; the whole picture when left out), turned
 * `turn` degrees clockwise, sized to fit `edge` pixels on its long side and
 * enlarged at most `maxUp` times, as PNG. `squeeze` narrows it to that share
 * of its width after sizing.
 */
async function part(
  src: Buffer,
  opts: { region?: Region; turn?: 0 | 90 | 180 | 270; edge?: number; maxUp?: number; scale?: number; squeeze?: number; pad?: boolean } = {},
): Promise<Picture> {
  let pipe = sharp(src);
  if (opts.region) {
    const meta = await sharp(src).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const left = Math.max(0, Math.min(W - 1, Math.floor(opts.region.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.floor(opts.region.y * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(opts.region.w * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(opts.region.h * H)));
    pipe = sharp(await pipe.extract({ left, top, width, height }).png({ compressionLevel: 0 }).toBuffer());
  }
  if (opts.turn) pipe = sharp(await pipe.rotate(opts.turn).png({ compressionLevel: 0 }).toBuffer());
  const meta = await pipe.clone().metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  let f = opts.scale ?? 1;
  if (opts.edge) f = Math.min(opts.edge / Math.max(w, h), opts.maxUp ?? 1);
  const tw = Math.max(1, Math.round(w * f * (opts.squeeze ?? 1)));
  const th = Math.max(1, Math.round(h * f));
  if (tw !== w || th !== h) pipe = pipe.resize(tw, th, { fit: "fill", kernel: "lanczos3" });
  // The reader enlarges a picture until its short side is 736 pixels, so a
  // thin strip would become huge and slow. Its edges are stretched to make
  // it squarer instead (no new text appears there).
  if (opts.pad) {
    const minSide = Math.ceil(Math.max(tw, th) * PAD_SHARE);
    const padH = Math.max(0, minSide - th);
    const padW = Math.max(0, minSide - tw);
    if (padH || padW) {
      pipe = sharp(await pipe.png({ compressionLevel: 0 }).toBuffer()).extend({
        top: Math.floor(padH / 2), bottom: Math.ceil(padH / 2), left: Math.floor(padW / 2), right: Math.ceil(padW / 2), extendWith: "copy",
      });
    }
  }
  const { data, info } = await pipe.png({ compressionLevel: 1 }).toBuffer({ resolveWithObject: true });
  const inner = opts.pad && (info.width !== tw || info.height !== th)
    ? { x: (info.width - tw) / 2 / info.width, y: (info.height - th) / 2 / info.height, w: tw / info.width, h: th / info.height }
    : undefined;
  return { png: data, width: info.width, height: info.height, inner };
}

/** Line boxes of a padded picture, as fractions of the part inside the padding. Lines in the padding are dropped. */
function unpad(lines: OcrLine[], pic: Picture): OcrLine[] {
  const inner = pic.inner;
  if (!inner) return lines;
  return lines.flatMap((l) => {
    const b = toView(l.box, inner, 0);
    return b ? [{ ...l, box: b }] : [];
  });
}

/** Lines of a read made on a part of the card, placed on the whole card. */
function placed(lines: OcrLine[], where: Region, source: OcrSource): OcrLine[] {
  return lines.map((l) => ({ ...l, box: mapBox(l.box, where), source }));
}

/**
 * Reads a photo through the given engine. Exported for tests with a fake engine.
 * A failure of the first read is passed on (a dead reader must fail the scan);
 * a failed re-read only loses that re-read, the best read so far stays.
 */
export async function readWith(engine: OcrEngine, image: Buffer, options: ReadOptions = {}): Promise<OcrResult> {
  const sink: { fix?: ReadFix } = {};
  const result = await readInner(engine, image, options, sink);
  return sink.fix ? { ...result, fix: sink.fix } : result;
}

/**
 * The text boxes that belong to the card found: those on it, and every box
 * that reaches them across a gap smaller than STRAY_GAP (print on a border
 * the finder missed stays). What is left is a cluster well apart from the
 * card; it is dropped only when it touches the photo's edge (a piece of
 * another card reaching into the photo).
 */
function linesOfCard(boxes: Box[], card: Box): Box[] {
  const near = (a: Box, b: Box) => {
    const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
    return dx < STRAY_GAP && dy < STRAY_GAP;
  };
  const kept = boxes.filter((b) => overlapShare(b, card) > 0);
  let rest = boxes.filter((b) => !kept.includes(b));
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of rest) {
      if (kept.some((k) => near(b, k))) {
        kept.push(b);
        grew = true;
      }
    }
    rest = rest.filter((b) => !kept.includes(b));
  }
  return kept;
}

/** The share of confident lines the found card must hold for the finder to be believed. */
const CARD_HOLDS_TEXT = 0.7;
/** A card found covering this share of the photo fills the frame: text well clear of it is another card's. */
const FRAME_CARD = 0.25;
/** "Well clear": this much empty photo (share of its sides) between such text and the card's own. */
const STRAY_GAP = 0.15;
/** Text this close to the photo's edge (share of its sides) touches it. */
const EDGE_TOUCH = 0.02;

async function readInner(engine: OcrEngine, image: Buffer, options: ReadOptions, sink: { fix?: ReadFix }): Promise<OcrResult> {
  const base = await oriented(image);
  const pic = await part(base, { edge: LONG_EDGE });
  if (pic.width < 8 || pic.height < 8) return summarize([], 0);
  const first = await engine.read(pic.png);
  // After the reader itself stopped working, no more re-reads are tried.
  let dead = false;
  const reread = async (png: Buffer): Promise<WorkerRead | null> => {
    if (dead) return null;
    try {
      return await engine.read(png);
    } catch (err) {
      if (err instanceof ReaderDownError) dead = true;
      return null;
    }
  };
  let best = linesFrom(first);
  let passes = 1;
  let crops = 0;
  // Product photos are read once; box labels are found inside their frames.
  if (options.thorough) return summarize(best, passes, crops);

  // 1. The card off the table, the right way up. A sideways photo (many 1980s
  // backs run across the long side) is turned, so boxes sit where they do on
  // the card and short words read better. The card is cut out only when it
  // fills clearly less than the photo; no read text is ever cut off.
  const { turn, trusted: turnSure } = turnWithTrust(first);
  let card: Region | null = null;
  let found: Box | null = null;
  try {
    found = await findCard(base);
    card = cropBox(found, best.filter((l) => l.confidence >= 0.6).map((l) => l.box));
  } catch {
    card = null;
  }
  let sure = best.filter((l) => l.confidence >= 0.6);
  const cardSure = found != null && sure.length > 0 && sure.filter((l) => overlapShare(l.box, found!) >= 0.9).length >= CARD_HOLDS_TEXT * sure.length;
  // A piece of another card at the edge of the photo (owner scan 11: part of
  // a Mills back over the top of a Milacki back): when the card found fills
  // much of the photo and holds most of the text, lines well clear of it are
  // not this card's print. They are left out of the read and of the crop.
  const strayFrom = cardSure && !options.quick && found && found.w * found.h >= FRAME_CARD ? found : null;
  let firstLines = first;
  if (strayFrom) {
    const keep = linesOfCard(best.map((l) => l.box), strayFrom);
    const mine = (b: Box) => keep.some((k) => overlapShare(b, k) > 0.5);
    // The piece reaches in from the photo's edge on its own side of the card:
    // above the card and touching the top, below it and touching the bottom,
    // and so on. Only text on such a side goes; print the finder left off the
    // card (its border) stays.
    const f = strayFrom;
    const sideOf = (b: Box) =>
      b.y + b.h <= f.y ? "top" : b.y >= f.y + f.h ? "bottom" : b.x + b.w <= f.x ? "left" : b.x >= f.x + f.w ? "right" : null;
    const touches = (b: Box, side: string) =>
      side === "top" ? b.y <= EDGE_TOUCH : side === "bottom" ? b.y + b.h >= 1 - EDGE_TOUCH : side === "left" ? b.x <= EDGE_TOUCH : b.x + b.w >= 1 - EDGE_TOUCH;
    const sides = new Set(best.flatMap((l) => {
      const side = sideOf(l.box);
      return !mine(l.box) && side && touches(l.box, side) ? [side] : [];
    }));
    const stray = (b: Box) => !mine(b) && sides.has(sideOf(b) ?? "");
    if (sides.size > 0) {
      best = best.filter((l) => !stray(l.box));
      sure = sure.filter((l) => !stray(l.box));
      firstLines = { ...first, lines: first.lines.filter((l) => { const b = boxOf(l.box, first.width, first.height); return b != null && !stray(b); }) };
      try {
        card = cropBox(found, sure.map((l) => l.box));
      } catch {
        card = null;
      }
    }
  }
  const fix: ReadFix = {
    turn, turnTrusted: turnSure, card: options.quick ? null : found, cardTrusted: !options.quick && cardSure,
    lines: best.map((l) => l.box),
  };
  sink.fix = fix;
  // Many cards from one photo come here already cut out: only the turn.
  const worthCrop = !options.quick && card != null && card.w * card.h < CROP_AREA;
  let view = base;
  // Boxes of the first read, placed on the card picture: the first read may
  // have seen spaced letters that the second read skipped.
  let firstOnView = linesFrom(firstLines, 1);
  if (turn || worthCrop) {
    const region = worthCrop ? card! : undefined;
    const upright = await part(base, { region, turn, edge: LONG_EDGE, maxUp: region ? MAX_UP : 1 });
    const secondRead = await reread(upright.png);
    const second = secondRead ? linesFrom(secondRead) : [];
    if (secondRead) passes++;
    // The new read is kept unless it read clearly less.
    if (secondRead && score(second) >= UPRIGHT_SHARE * score(best)) {
      firstOnView = firstOnView.flatMap((l) => {
        const box = toView(l.box, region, turn);
        return box ? [{ ...l, box }] : [];
      });
      best = second;
      view = (await part(base, { region, turn })).png;
    } else if (turn) {
      // The upright re-read did not confirm the turn.
      fix.turnTrusted = false;
    }
  }
  if (options.quick) return summarize(best, passes, crops);
  const aspect = await sharp(view).metadata().then((m) => (m.width ?? 1) / (m.height ?? 1));

  // 2. Bands of spaced letters ("D O N R U S S  1 9 9 2") read again, squeezed
  // to half their width, so the letters stand close as the reader expects.
  const seen = turn || worthCrop ? [...best, ...firstOnView] : firstOnView;
  for (const band of spacedBands(seen, aspect, MAX_BANDS)) {
    const scale = BAND_HEIGHT / Math.max(1, band.h * (await heightOf(view)));
    // Read at two squeezes; kept only when both read the same words, so a
    // letter squeezed out of shape ("1992" read as "1991") never gets in.
    const reads: OcrLine[][] = [];
    for (const squeeze of BAND_SQUEEZES) {
      const strip = await part(view, { region: band, scale, squeeze, pad: true });
      const got = await reread(strip.png);
      // A failed re-read counts as reading nothing: the band is skipped.
      reads.push(got ? unpad(linesFrom(got), strip) : []);
      if (got) crops++;
    }
    // Same letters in the same order, spaces aside; the read that kept the
    // words apart ("DONRUSS" "1992", not "DONRUSS1992") is the one used.
    const letters = (ls: OcrLine[]) => [...ls].sort((a, b) => a.box.x - b.box.x).map((l) => l.text.toUpperCase().replace(/\s+/g, "")).join("");
    const words = (ls: OcrLine[]) => ls.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
    if (reads.some((r) => r.length === 0) || new Set(reads.map(letters)).size !== 1) continue;
    const got = placed(reads.reduce((a, b) => (words(b) > words(a) || (words(b) === words(a) && score(b) > score(a)) ? b : a)), band, "band");
    if (score(got) <= score(best.filter((l) => insideBand(l.box, band)))) continue;
    best = [...best.filter((l) => !insideBand(l.box, band)), ...got];
  }

  // 3. On a back, each corner read again larger: the card number sits in one.
  if (options.back || options.backIf?.(summarize(best, passes, crops))) {
    for (const corner of cornerBoxes()) {
      const zoomed = await part(view, { region: corner, edge: CORNER_EDGE, maxUp: CORNER_MAX_UP, pad: true });
      const got = await reread(zoomed.png);
      if (!got) continue;
      const read = unpad(linesFrom(got), zoomed);
      crops++;
      for (const g of placed(read.filter((l) => keepCornerLine(l.text, l.box)), corner, "corner")) {
        // Already read as part of a longer line: nothing new. Read exactly the
        // same on its own both times: the two reads agree, which is noted.
        const plain = g.text.replace(/\s+/g, "");
        const same = best.filter((l) => overlapShare(g.box, l.box) > 0.5 && l.text.replace(/\s+/g, "").includes(plain));
        if (same.length > 0) {
          best = best.map((l) => (same.includes(l) && l.text.replace(/\s+/g, "") === plain ? { ...l, twice: true } : l));
          continue;
        }
        // The larger read replaces what the first read made of the same spot.
        best = [...best.filter((l) => overlapShare(l.box, g.box) <= 0.5), g];
      }
    }
  }
  return summarize(best, passes, crops);
}

async function heightOf(png: Buffer): Promise<number> {
  return (await sharp(png).metadata()).height ?? 1;
}

/** A line whose middle lies inside a band. */
function insideBand(b: Box, band: Region): boolean {
  const mid = b.y + b.h / 2;
  return mid >= band.y && mid <= band.y + band.h;
}

type Holder = { engine?: OcrEngine };
const STATE_KEY = Symbol.for("crd.free.ocr");
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: Holder };

function holder(): Holder {
  const g = globalThis as GlobalWithState;
  return (g[STATE_KEY] ??= {});
}

function engine(): OcrEngine {
  const h = holder();
  h.engine ??= pythonEngine();
  return h.engine;
}

/** A reader over any engine, e.g. a fake worker in tests. */
export function createTextReader(e: OcrEngine): TextReader {
  return { read: (image, options) => readWith(e, image, options) };
}

const reader: TextReader = {
  read(image: Buffer, options?: ReadOptions): Promise<OcrResult> {
    return readWith(engine(), image, options);
  },
};

export function getTextReader(): TextReader {
  return reader;
}

/** For the health check: is the reader worker up? Never starts it. */
export function textReaderStatus(): ReaderStatus {
  return holder().engine?.status() ?? "waiting";
}

/** Stops the shared worker. The next read starts a fresh one. */
export async function closeTextReader(): Promise<void> {
  const h = holder();
  const e = h.engine;
  h.engine = undefined;
  await e?.close();
}

export { ReaderDownError };
export type { OcrEngine, ReaderStatus, WorkerLine, WorkerRead };
