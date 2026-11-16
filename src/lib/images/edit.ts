import sharp, { type Sharp, type SharpOptions } from "sharp";
import { z } from "zod";

/** Largest cut from one side, in percent. */
export const TRIM_MAX_PERCENT = 40;
/** What is left of a photo after a trim must be at least this many pixels on each side. */
export const MIN_TRIMMED_SIDE = 200;

const percent = z.number().int().min(0).max(TRIM_MAX_PERCENT);

/** What the owner can ask for. Checked again on the server whatever the browser did. */
export const photoEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), direction: z.enum(["left", "right"]) }),
  z.object({ kind: z.literal("trim"), top: percent, bottom: percent, left: percent, right: percent }),
]);
export type PhotoEdit = z.infer<typeof photoEditSchema>;

export class EditError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "EditError";
    this.userMessage = userMessage;
  }
}

/** The pixels a trim cuts away, from the photo's own size. Throws EditError when too little would be left. */
export function trimBox(width: number, height: number, t: { top: number; bottom: number; left: number; right: number }) {
  const left = Math.round((width * t.left) / 100);
  const right = Math.round((width * t.right) / 100);
  const top = Math.round((height * t.top) / 100);
  const bottom = Math.round((height * t.bottom) / 100);
  const w = width - left - right;
  const h = height - top - bottom;
  if (w < MIN_TRIMMED_SIDE || h < MIN_TRIMMED_SIDE) {
    throw new EditError("That would leave too little of the photo. Trim less.");
  }
  return { left, top, width: w, height: h };
}

/**
 * Applies one edit to a sharp pipeline (no encoding here). The photo is
 * already upright and has no metadata, so only the cut or turn is done.
 */
export function applyEdit(input: Buffer, width: number, height: number, edit: PhotoEdit, decode: SharpOptions): Sharp {
  const base = sharp(input, decode);
  if (edit.kind === "turn") return base.rotate(edit.direction === "left" ? 270 : 90);
  if (edit.top + edit.bottom + edit.left + edit.right === 0) throw new EditError("Move a slider first, there is nothing to trim yet.");
  return base.extract(trimBox(width, height, edit));
}

export const QUEUE_BUSY_MESSAGE = "Busy with other photos. Try again in a moment.";
export const JOB_TIMEOUT_MESSAGE = "That took too long and was stopped. Nothing was changed. Try again.";
/** At most this many jobs may wait behind the one running. */
export const MAX_WAITING = 3;
export const JOB_TIMEOUT_MS = 60_000;

/** Given to a job so it can tell, once it finishes, that it was stopped for taking too long. */
export type JobControl = { expired: () => boolean };

/**
 * One picture job at a time: this server is slow, so edits wait in line instead
 * of running together. A fourth waiting job is refused, and a job that runs
 * longer than the time limit is given up on so the line moves on (its own
 * code must clean up when `expired()` is true after it finishes).
 */
let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;
export function runOneAtATime<T>(job: (ctl: JobControl) => Promise<T>, timeoutMs = JOB_TIMEOUT_MS): Promise<T> {
  if (waiting >= MAX_WAITING) return Promise.reject(new EditError(QUEUE_BUSY_MESSAGE));
  waiting++;
  const start = async (): Promise<T> => {
    waiting--;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stopped = true; reject(new EditError(JOB_TIMEOUT_MESSAGE)); }, timeoutMs);
    });
    const running = job({ expired: () => stopped });
    running.catch(() => {});
    try {
      return await Promise.race([running, limit]);
    } finally {
      clearTimeout(timer);
    }
  };
  const next = tail.then(start, start);
  tail = next.catch(() => undefined);
  return next;
}

/** One edit at a time for each photo. Returns a release function, or null when the photo is busy. */
const busy = new Set<number>();
export function lockPhoto(id: number): (() => void) | null {
  if (busy.has(id)) return null;
  busy.add(id);
  return () => { busy.delete(id); };
}
