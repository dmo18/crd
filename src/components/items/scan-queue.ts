import type { ScanView } from "@/lib/scans/view";

/** Most scans one visit can hold. */
export const MAX_QUEUE = 100;
/** Photos uploading at the same time. */
export const MAX_PARALLEL = 2;
/** How long a scan may stay unfinished before the page stops waiting. */
export const GIVE_UP_MS = 5 * 60 * 1000;
export const TIMEOUT_MESSAGE = "This is taking too long. Check Review or Inventory later.";

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
      return state;
    }
    case "failed":
      return patch(state, action.key, (e) =>
        e.status === "sending" || e.status === "reading" ? { ...e, status: "failed", error: action.message } : e,
      );
    case "retry":
      return patch(state, action.key, (e) =>
        e.status === "failed" ? { ...e, status: "waiting", error: null, scan: null, scanId: null, uploadedAt: null } : e,
      );
    case "timeout":
      return patch(state, action.key, (e) => (e.status === "reading" ? { ...e, status: "failed", error: TIMEOUT_MESSAGE } : e));
  }
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
