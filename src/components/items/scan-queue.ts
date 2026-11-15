import type { ScanView } from "@/lib/scans/view";

/** Most scans one visit can hold. */
export const MAX_QUEUE = 100;
/** Photos uploading at the same time. */
export const MAX_PARALLEL = 2;
/**
 * How long after the server STARTED reading a scan the page stops waiting.
 * The server reads one scan at a time and gives each up to 5 minutes, so a
 * scan waiting in line is never timed out, however long the line is.
 */
export const GIVE_UP_AFTER_START_MS = 6 * 60 * 1000;
export const TIMEOUT_MESSAGE = "This is taking too long. It may still finish: check Review or Inventory later.";

/** True when the server has been reading this scan for longer than the page waits. Uses the server's clock only. */
export function scanTimedOut(scan: Pick<ScanView, "status" | "startedAt" | "serverTime"> | null): boolean {
  if (!scan || scan.status !== "processing" || scan.startedAt === null) return false;
  return scan.serverTime - scan.startedAt > GIVE_UP_AFTER_START_MS;
}

/** A short line about where a scan is, for the waiting screen and the queue list. */
export function waitingText(scan: Pick<ScanView, "status" | "queuePosition"> | null): string | null {
  if (!scan || scan.status !== "queued" || scan.queuePosition === null) return null;
  if (scan.queuePosition <= 1) return "Next in line.";
  const ahead = scan.queuePosition - 1;
  return ahead === 1 ? "Waiting in line: 1 scan ahead of this one." : `Waiting in line: ${ahead} scans ahead of this one.`;
}

export type QueueStatus = "waiting" | "sending" | "reading" | "done" | "failed";

export type QueueEntry = {
  /** Local id, unique in this visit. */
  key: number;
  name: string;
  previewUrl: string | null;
  status: QueueStatus;
  scanId: number | null;
  /** When the upload finished (ms), used for the give-up timer. */
  uploadedAt: number | null;
  error: string | null;
  scan: ScanView | null;
};

/** Entries in the order they were added (oldest first). */
export type QueueState = { entries: QueueEntry[] };

export type QueueAction =
  | { type: "add"; key: number; name: string; previewUrl: string | null }
  | { type: "sending"; key: number }
  | { type: "uploaded"; key: number; scanId: number; at: number }
  | { type: "update"; scan: ScanView }
  | { type: "failed"; key: number; message: string }
  | { type: "retry"; key: number }
  | { type: "requeued"; key: number; scan: ScanView | null }
  | { type: "retryError"; key: number; message: string }
  | { type: "timeout"; key: number };

export const emptyQueue: QueueState = { entries: [] };

function patch(state: QueueState, key: number, fn: (e: QueueEntry) => QueueEntry): QueueState {
  let changed = false;
  const entries = state.entries.map((e) => {
    if (e.key !== key) return e;
    const next = fn(e);
    if (next !== e) changed = true;
    return next;
  });
  return changed ? { entries } : state;
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "add":
      if (state.entries.length >= MAX_QUEUE || state.entries.some((e) => e.key === action.key)) return state;
      return {
        entries: [
          ...state.entries,
          { key: action.key, name: action.name, previewUrl: action.previewUrl, status: "waiting", scanId: null, uploadedAt: null, error: null, scan: null },
        ],
      };
    case "sending":
      return patch(state, action.key, (e) => (e.status === "waiting" ? { ...e, status: "sending", error: null } : e));
    case "uploaded":
      return patch(state, action.key, (e) =>
        e.status === "sending" ? { ...e, status: "reading", scanId: action.scanId, uploadedAt: action.at } : e,
      );
    case "update": {
      const { scan } = action;
      const target = state.entries.find((e) => e.scanId === scan.id && e.status === "reading");
      if (!target) return state;
      if (scan.status === "done") return patch(state, target.key, (e) => ({ ...e, status: "done", scan, error: null }));
      if (scan.status === "failed") {
        return patch(state, target.key, (e) => ({ ...e, status: "failed", scan, error: scan.error ?? "The scan did not work. Please try again." }));
      }
      // Still queued or being read: keep the latest view for the timer and the place in line.
      return patch(state, target.key, (e) => ({ ...e, scan }));
    }
    case "failed":
      return patch(state, action.key, (e) =>
        e.status === "sending" || e.status === "reading" ? { ...e, status: "failed", error: action.message } : e,
      );
    case "retry":
      // Upload again: only for photos the server never accepted.
      return patch(state, action.key, (e) =>
        e.status === "failed" && e.scanId === null ? { ...e, status: "waiting", error: null, scan: null, uploadedAt: null } : e,
      );
    case "requeued":
      // The server runs the same scan again with the photos it already has.
      return patch(state, action.key, (e) =>
        e.status === "failed" && e.scanId !== null ? { ...e, status: "reading", error: null, scan: action.scan } : e,
      );
    case "retryError":
      return patch(state, action.key, (e) => (e.status === "failed" ? { ...e, error: action.message } : e));
    case "timeout":
      return patch(state, action.key, (e) => (e.status === "reading" ? { ...e, status: "failed", error: TIMEOUT_MESSAGE } : e));
  }
}

export type RetryKind = "upload" | "server" | null;

/**
 * How a failed entry can be retried. A photo the server never accepted is
 * uploaded again. A scan the server accepted is retried on the server, and
 * only when the server itself says it failed; otherwise (for example the
 * page stopped waiting) Retry stays hidden, because uploading again would
 * create a duplicate.
 */
export function retryKind(e: Pick<QueueEntry, "status" | "scanId" | "scan" | "previewUrl">): RetryKind {
  if (e.status !== "failed") return null;
  if (e.scanId === null) return e.previewUrl !== null ? "upload" : null;
  return e.scan?.status === "failed" ? "server" : null;
}

/** Keys to start uploading now: oldest waiting first, never more than maxParallel in flight. */
export function nextToSend(state: QueueState, maxParallel: number = MAX_PARALLEL): number[] {
  const inFlight = state.entries.filter((e) => e.status === "sending").length;
  const free = Math.max(0, maxParallel - inFlight);
  return state.entries.filter((e) => e.status === "waiting").slice(0, free).map((e) => e.key);
}

export type QueueSummary = { scanned: number; done: number; needsReview: number; failed: number; unfinished: number };

export function summary(state: QueueState): QueueSummary {
  let done = 0, needsReview = 0, failed = 0, unfinished = 0;
  for (const e of state.entries) {
    if (e.status === "done") {
      done += 1;
      if (e.scan?.items.some((i) => i.status === "needs_review")) needsReview += 1;
    } else if (e.status === "failed") failed += 1;
    else unfinished += 1;
  }
  return { scanned: state.entries.length, done, needsReview, failed, unfinished };
}

export function summaryText(s: QueueSummary): string {
  const parts = [`${s.scanned} scanned`, `${s.done} done`];
  if (s.needsReview > 0) parts.push(`${s.needsReview} needs review`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return parts.join(" · ");
}

export function atCap(state: QueueState): boolean {
  return state.entries.length >= MAX_QUEUE;
}
