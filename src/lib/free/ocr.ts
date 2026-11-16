import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Box } from "@/lib/recognition/types";
import { WorkerClient, type OcrEngine, type ReaderStatus, type WorkerLine, type WorkerRead } from "./ocr-worker";

/**
 * Reads printed text from card photos on the server, fully offline, with
 * RapidOCR (PP-OCR models on onnxruntime) in a Python worker started by the
 * app (see ocr-worker.ts and ocr/worker.py). The models are files in the
 * image, never downloaded at run time. Never logs image data or text.
 */

/**
 * Where a line came from. The current reader reads the whole photo, so every
 * line is "page". "band" and "edge" were separate passes of the old reader;
 * the parser still accepts them.
 */
export type OcrSource = "page" | "band" | "edge";
/**
 * One text box: its text, the reader's confidence (0 to 1) and where it sits
 * as fractions of the picture (the photo, or the photo turned upright when it
 * was read sideways).
 */
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
   * Box labels and bulk boxes. The reader finds labels inside dark frames on
   * its own, so this reads like a card photo without the sideways re-read.
   */
  thorough?: boolean;
  /** Many cards from one photo. Same single read; kept for callers. */
  quick?: boolean;
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
/** The upright re-read of a sideways photo wins unless it scores below this share of the first read. */
const UPRIGHT_SHARE = 0.8;
const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;

const Settings = z.object({
  OCR_PYTHON: z.string().trim().min(1).max(1024).default("python3"),
  OCR_WORKER: z.string().trim().min(1).max(1024).optional(),
  OCR_MODELS_DIR: z.string().trim().max(1024).default(""),
  OCR_THREADS: z.coerce.number().int().min(1).max(8).default(4),
});

/** Where the reader's Python and worker are, from env settings (see .env.example). */
export function readerSettings(source: Record<string, string | undefined> = process.env) {
  const raw = Object.fromEntries(
    ["OCR_PYTHON", "OCR_WORKER", "OCR_MODELS_DIR", "OCR_THREADS"]
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

function linesFrom(read: WorkerRead): OcrLine[] {
  const out: OcrLine[] = [];
  for (const l of read.lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    const signal = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const confidence = clamp01(l.score);
    if (signal < MIN_LINE_CHARS || confidence < MIN_LINE_CONFIDENCE) continue;
    const box = boxOf(l.box, read.width, read.height);
    if (!box) continue;
    out.push({ text, confidence, box, source: "page" });
  }
  return out;
}

function score(lines: OcrLine[]): number {
  return lines.reduce((sum, l) => sum + l.confidence * l.text.length, 0);
}

function summarize(lines: OcrLine[], passes: number): OcrResult {
  const chars = lines.reduce((sum, l) => sum + l.text.length, 0);
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    confidence: chars > 0 ? score(lines) / chars : 0,
    passes,
  };
}

/**
 * Which way a sideways photo must turn (degrees clockwise) to stand upright,
 * or 0 when most of its text already runs across. The worker turns tall boxes
 * a quarter to the left before reading and says when it then also turned a
 * line upside down: such text runs up the photo (turn 90), other tall text
 * runs down it (turn 270).
 */
export function sidewaysTurn(read: WorkerRead): 0 | 90 | 270 {
  let across = 0;
  let up = 0;
  let down = 0;
  for (const l of read.lines) {
    const xs = l.box.map((p) => p[0]);
    const ys = l.box.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const weight = l.text.replace(/\s/g, "").length * l.score;
    if (h >= TALL * w) {
      if (l.turned) up += weight;
      else down += weight;
    } else {
      across += weight;
    }
  }
  if (up + down <= across || up + down < 4) return 0;
  return up > down ? 90 : 270;
}

type Picture = { png: Buffer; width: number; height: number };

/** The photo the right way up (camera orientation applied), at most LONG_EDGE, as PNG. */
async function picture(image: Buffer, turn: 0 | 90 | 270 = 0): Promise<Picture> {
  let pipe = sharp(image, DECODE_OPTIONS).rotate();
  if (turn) pipe = sharp(await pipe.toBuffer()).rotate(turn);
  const { data, info } = await pipe
    .flatten({ background: "#ffffff" })
    .resize(LONG_EDGE, LONG_EDGE, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 1 })
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** Reads a photo through the given engine. Exported for tests with a fake engine. */
export async function readWith(engine: OcrEngine, image: Buffer, options: ReadOptions = {}): Promise<OcrResult> {
  const pic = await picture(image);
  if (pic.width < 8 || pic.height < 8) return summarize([], 0);
  const first = await engine.read(pic.png);
  let best = linesFrom(first);
  let passes = 1;
  // A sideways photo (many 1980s backs run across the long side) is read once
  // more turned upright, so line boxes sit where they do on the card and short
  // words read better. The upright read is kept unless it read clearly less.
  const turn = options.thorough ? 0 : sidewaysTurn(first);
  if (turn) {
    const upright = await picture(image, turn);
    const second = linesFrom(await engine.read(upright.png));
    passes++;
    if (score(second) >= UPRIGHT_SHARE * score(best)) best = second;
  }
  return summarize(best, passes);
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

export type { OcrEngine, ReaderStatus, WorkerLine, WorkerRead };
