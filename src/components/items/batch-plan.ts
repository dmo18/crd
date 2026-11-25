import { MAX_BATCH_PHOTOS } from "@/lib/scans/batch-limits";
import { isFinished, MAX_QUEUE, type QueueState } from "./scan-queue";

/** How the photos of a "Many photos, one card each" upload are laid out. */
export type BatchLayout = "fronts" | "pairs";

/** Shown on the check screen for front and back uploads. */
export const PAIRING_LINE = "Photos are paired in the order shown here. If a front and back do not match, remove the photos and pick them again in order: front, back, front, back.";

export type BatchCard<F> = { front: F; back?: F };
export type BatchPlan<F> = { ok: true; cards: BatchCard<F>[] } | { ok: false; error: string };

/**
 * Turns the picked photos into cards, in the order they were picked:
 * one card per photo, or front then back for each card.
 */
export function planBatch<F>(files: readonly F[], layout: BatchLayout, room: number = MAX_QUEUE): BatchPlan<F> {
  if (files.length === 0) return { ok: false, error: "Pick at least one photo." };
  if (files.length > MAX_BATCH_PHOTOS) {
    return { ok: false, error: `You picked ${files.length} photos. The limit is ${MAX_BATCH_PHOTOS} at a time. Pick fewer.` };
  }
  let cards: BatchCard<F>[];
  if (layout === "pairs") {
    if (files.length % 2 !== 0) {
      return { ok: false, error: `You picked ${files.length} photos. For front and back, pick an even number: each card needs its front and then its back.` };
    }
    cards = [];
    for (let i = 0; i < files.length; i += 2) cards.push({ front: files[i]!, back: files[i + 1]! });
  } else {
    cards = files.map((front) => ({ front }));
  }
  if (cards.length > room) {
    return {
      ok: false,
      error: room <= 0
        ? "The list on this page is full. Wait for the photos above to be saved and read, then try again."
        : `Only ${room} more ${room === 1 ? "card fits" : "cards fit"} in the list on this page right now. Wait for some to be read, or pick fewer.`,
    };
  }
  return { ok: true, cards };
}

/** How many more scans the page's list can take now (finished ones make room as new ones come). */
export function batchRoom(state: QueueState): number {
  return MAX_QUEUE - state.entries.filter((e) => !isFinished(e)).length;
}

export type BatchProgress = {
  batch: string;
  total: number;
  /** The server has it. */
  sent: number;
  /** Given up for now: can be sent again with "Send the rest again". */
  notSent: number;
  /** Still being sent or waiting to be sent. */
  sending: number;
};

/** Sending progress of each upload on this page, oldest first. */
export function batchProgress(state: QueueState): BatchProgress[] {
  const out = new Map<string, BatchProgress>();
  for (const e of state.entries) {
    if (e.batch === null) continue;
    const p = out.get(e.batch) ?? { batch: e.batch, total: 0, sent: 0, notSent: 0, sending: 0 };
    p.total += 1;
    if (e.scanId !== null) p.sent += 1;
    else if (e.status === "failed") p.notSent += 1;
    else p.sending += 1;
    out.set(e.batch, p);
  }
  return [...out.values()];
}

/** The one progress line, for example "12 of 40 sent". */
export function progressLine(p: BatchProgress): string {
  if (p.sent === p.total) return `All ${p.total} sent. They are read one at a time, about half a minute each.`;
  return `${p.sent} of ${p.total} sent`;
}

/** Keys of the entries of this upload that the server never got and that can be sent again. */
export function unsentKeys(state: QueueState, batch: string): number[] {
  return state.entries
    .filter((e) => e.batch === batch && e.status === "failed" && e.scanId === null && e.failure !== "final" && e.previewUrl !== null)
    .map((e) => e.key);
}
