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

/** Seconds to wait before each automatic try after a failed upload: 3 more tries. */
export const RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;
export const NOT_SAVED_MESSAGE = "Could not send the photos. Check your connection.";
/** One upload try is stopped after this long and counts as a failed try that is tried again. */
export const UPLOAD_TIMEOUT_MS = 90_000;
export const UPLOAD_TIMEOUT_MESSAGE = "Sending took too long. Check your connection.";

/**
 * Why an upload failed.
 * - "retryable": no answer, a timeout, a server error, 408 or 429. Tried again on its own, then Retry.
 * - "rejected": the server refused it (4xx). Stops at once; Retry is offered.
 * - "final": 400, 413 or 415. Stops at once; trying again cannot help, so no Retry.
 * - "signIn": 401. Stops at once; Retry is offered with a "Sign in again" link.
 */
export type UploadFailure = "retryable" | "rejected" | "final" | "signIn";

/** How a failed answer from the server is handled, by its HTTP status. */
export function failureFor(status: number): UploadFailure {
  if (status === 401) return "signIn";
  if (status === 400 || status === 413 || status === 415) return "final";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "retryable";
}

/** "backoff" means the upload failed and the page will try again on its own soon. */
export type QueueStatus = "waiting" | "sending" | "backoff" | "reading" | "done" | "failed";

export type QueueEntry = {
  /** Local id, unique in this visit. */
  key: number;
  /** Random id sent as `clientKey` on every try, so a repeat never makes a second scan. */
  clientKey: string;
  name: string;
  previewUrl: string | null;
  status: QueueStatus;
  scanId: number | null;
  /** Automatic retries used so far (0 to 3). */
  attempt: number;
  /** When the upload finished (ms), used for the give-up timer. */
  uploadedAt: number | null;
  error: string | null;
  /** Why the last upload failed, while it is not saved. */
  failure: UploadFailure | null;
  scan: ScanView | null;
};

/** Entries in the order they were added (oldest first). */
export type QueueState = { entries: QueueEntry[] };

export type QueueAction =
  | { type: "add"; key: number; clientKey: string; name: string; previewUrl: string | null }
  | { type: "sending"; key: number }
  | { type: "uploadFailed"; key: number; message: string; failure?: UploadFailure }
  /** The page let go of the photo preview (the photo is no longer needed or can no longer be sent). */
  | { type: "released"; key: number }
  | { type: "retryDue"; key: number }
  | { type: "uploaded"; key: number; scanId: number; at: number }
  | { type: "update"; scan: ScanView }
  | { type: "failed"; key: number; message: string }
  | { type: "retry"; key: number }
  | { type: "requeued"; key: number; scan: ScanView | null }
  | { type: "retryError"; key: number; message: string }
  | { type: "timeout"; key: number }
  /** The list is full: drop the oldest finished entry to make room. Never drops one the server may not have. */
  | { type: "makeRoom" };

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
          { key: action.key, clientKey: action.clientKey, name: action.name, previewUrl: action.previewUrl, status: "waiting", scanId: null, attempt: 0, uploadedAt: null, error: null, failure: null, scan: null },
        ],
      };
    case "sending":
      return patch(state, action.key, (e) => (e.status === "waiting" ? { ...e, status: "sending", error: null } : e));
    case "uploadFailed":
      // Try again on its own 3 times (after 2, 8 and 20 seconds), then give up and keep the photo.
      // A refusal by the server (most 4xx) stops at once: trying again would get the same answer.
      return patch(state, action.key, (e) => {
        if (e.status !== "sending") return e;
        const failure = action.failure ?? "retryable";
        if (failure === "retryable" && e.attempt < RETRY_DELAYS_MS.length) {
          return { ...e, status: "backoff", attempt: e.attempt + 1, error: action.message, failure };
        }
        return { ...e, status: "failed", error: action.message, failure };
      });
    case "released":
      return patch(state, action.key, (e) => (e.previewUrl === null ? e : { ...e, previewUrl: null }));
    case "retryDue":
      return patch(state, action.key, (e) => (e.status === "backoff" ? { ...e, status: "waiting" } : e));
    case "uploaded":
      return patch(state, action.key, (e) =>
        e.status === "sending" ? { ...e, status: "reading", scanId: action.scanId, uploadedAt: action.at, error: null, failure: null } : e,
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
        e.status === "failed" && e.scanId === null ? { ...e, status: "waiting", attempt: 0, error: null, failure: null, scan: null, uploadedAt: null } : e,
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
    case "makeRoom": {
      if (state.entries.length < MAX_QUEUE) return state;
      const at = state.entries.findIndex(isFinished);
      if (at < 0) return state;
      return { entries: state.entries.filter((_, i) => i !== at) };
    }
  }
}

/**
 * True when an entry is completely finished and safe to forget: read (done),
 * or failed on the server after it was saved and read. Never true for an
 * entry that is not yet saved, still being read, or that only timed out on
 * the page (the server may still finish it).
 */
export function isFinished(e: Pick<QueueEntry, "status" | "scanId" | "scan">): boolean {
  if (e.status === "done") return true;
  return e.status === "failed" && e.scanId !== null && e.scan?.status === "failed";
}

export type RetryKind = "upload" | "server" | null;

/**
 * How a failed entry can be retried. A photo the server never accepted is
 * uploaded again. A scan the server accepted is retried on the server, and
 * only when the server itself says it failed; otherwise (for example the
 * page stopped waiting) Retry stays hidden, because uploading again would
 * create a duplicate.
 */
export function retryKind(e: Pick<QueueEntry, "status" | "scanId" | "scan" | "previewUrl" | "failure">): RetryKind {
  if (e.status !== "failed") return null;
  if (e.scanId === null) return e.failure !== "final" && e.previewUrl !== null ? "upload" : null;
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

/**
 * True when the page can let go of an entry's photo and preview: the server
 * has it and is done with it (read, failed on the server, or the page stopped
 * waiting), or the server refused it for good. A photo that may still be sent
 * again (Not saved with Retry) is kept.
 */
export function canRelease(e: Pick<QueueEntry, "status" | "scanId" | "failure">): boolean {
  if (e.status === "done") return true;
  if (e.status !== "failed") return false;
  return e.scanId !== null || e.failure === "final";
}

/** The one line read out by screen readers whenever the counts change, for example "2 saving, 1 not saved". */
export function liveText(state: QueueState): string {
  let saving = 0, reading = 0, read = 0, notSaved = 0, didNotWork = 0;
  for (const e of state.entries) {
    const { kind } = entryState(e);
    if (kind === "saving") saving += 1;
    else if (kind === "saved" || kind === "slow") reading += 1;
    else if (kind === "not_saved") notSaved += 1;
    else if (kind === "did_not_work") didNotWork += 1;
    else read += 1;
  }
  const parts: string[] = [];
  if (saving > 0) parts.push(`${saving} saving`);
  if (reading > 0) parts.push(`${reading} saved, being read`);
  if (read > 0) parts.push(`${read} read`);
  if (notSaved > 0) parts.push(`${notSaved} not saved`);
  if (didNotWork > 0) parts.push(`${didNotWork} did not work`);
  if (parts.length === 0) return "";
  const line = parts.join(", ") + ".";
  return hasUnsaved(state) ? `${line} ${KEEP_OPEN_MESSAGE}` : line;
}

export const KEEP_OPEN_MESSAGE = "Keep this page open until your photos are saved.";

export function atCap(state: QueueState): boolean {
  return state.entries.length >= MAX_QUEUE;
}

/** True when no more can be added: the list is at its limit and no entry is finished enough to drop. */
export function listFull(state: QueueState): boolean {
  return atCap(state) && !state.entries.some(isFinished);
}

/** True while any photo is not yet safely on the server: the leave warning is on. */
export function hasUnsaved(state: QueueState): boolean {
  return state.entries.some((e) => e.scanId === null && e.status !== "done");
}

/** How long to wait before the next automatic try for an entry in "backoff". */
export function retryDelayMs(e: Pick<QueueEntry, "attempt">): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(e.attempt, 1), RETRY_DELAYS_MS.length) - 1];
}

export type EntryKind = "saving" | "saved" | "read" | "check" | "empty" | "not_saved" | "did_not_work" | "slow";

/** What one entry says to the owner, in plain words. */
export function entryState(e: Pick<QueueEntry, "status" | "scanId" | "scan" | "error">): { kind: EntryKind; text: string } {
  switch (e.status) {
    case "waiting":
    case "sending":
      return { kind: "saving", text: "Saving" };
    case "backoff":
      return { kind: "saving", text: "Saving, trying again soon" };
    case "reading":
      return { kind: "saved", text: e.scan?.status === "queued" ? "Saved, waiting to be read" : "Saved, being read" };
    case "done":
      if (!e.scan || e.scan.items.length === 0) return { kind: "empty", text: "No card found" };
      if (e.scan.items.some((i) => i.status === "needs_review")) return { kind: "check", text: "Check this one" };
      return { kind: "read", text: "Read" };
    case "failed":
      if (e.scanId === null) return { kind: "not_saved", text: "Not saved" };
      if (e.scan?.status === "failed") return { kind: "did_not_work", text: "Did not work" };
      return { kind: "slow", text: "Saved, taking longer than usual" };
  }
}

// ---- Sending ----

/** Everything needed to send one entry. Kept in page memory until the server has it. */
export type ScanJob = {
  mode: string;
  clientKey: string;
  hint: string;
  locationId: string;
  front?: File;
  back?: File;
  source: File[];
};

export function buildScanBody(job: ScanJob): FormData {
  const body = new FormData();
  body.set("mode", job.mode);
  body.set("clientKey", job.clientKey);
  if (job.hint.trim()) body.set("hint", job.hint.trim());
  if (job.locationId) body.set("locationId", job.locationId);
  if (job.front) body.set("front", job.front);
  if (job.back) body.set("back", job.back);
  for (const f of job.source) body.append("source", f);
  return body;
}

export type SendResult = { ok: true; scanId: number } | { ok: false; message: string; failure: UploadFailure };

const SERVER_MESSAGE_MAX = 200;

/**
 * One try. Saved only when the server answered 201 (new) or 200 (it already
 * had this clientKey), with a scan id. The try is stopped after `timeoutMs`
 * (90 seconds) so a stalled connection never holds a place in the queue.
 */
export async function postScan(fetchFn: typeof fetch, job: ScanJob, timeoutMs: number = UPLOAD_TIMEOUT_MS): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn("/api/scans", { method: "POST", body: buildScanBody(job), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, message: timedOut ? UPLOAD_TIMEOUT_MESSAGE : NOT_SAVED_MESSAGE, failure: "retryable" };
  }
  let data: { scanId?: unknown; error?: unknown } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // No JSON (for example a proxy error page, or the body timed out): handled by status below.
  }
  if ((res.status === 201 || res.status === 200) && typeof data.scanId === "number") return { ok: true, scanId: data.scanId };
  const failure = failureFor(res.status);
  // The server's own short message for a refusal; never a long or odd body.
  const said = typeof data.error === "string" && data.error.trim() !== "" && data.error.length <= SERVER_MESSAGE_MAX ? data.error : null;
  if (failure === "signIn") return { ok: false, message: said ?? "Please sign in.", failure };
  if (failure === "retryable") return { ok: false, message: res.status === 429 || res.status >= 500 ? (said ?? NOT_SAVED_MESSAGE) : NOT_SAVED_MESSAGE, failure };
  return { ok: false, message: said ?? "The server did not accept these photos.", failure };
}

export type UploaderDeps = {
  getState: () => QueueState;
  dispatch: (a: QueueAction) => void;
  /** One try for an entry. */
  send: (key: number) => Promise<SendResult>;
  /** Run `fn` after `ms`. */
  later: (fn: () => void, ms: number) => void;
  now: () => number;
  /** Called once per entry when the server has it. */
  onSaved: (key: number) => void;
};

/**
 * Starts waiting entries (at most MAX_PARALLEL at once, one try per entry at
 * a time) and schedules the automatic retries. Call `pump` after every state change.
 */
export function createUploader(deps: UploaderDeps): { pump: () => void } {
  const inFlight = new Set<number>();
  function pump() {
    for (const key of nextToSend(deps.getState(), MAX_PARALLEL)) {
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      deps.dispatch({ type: "sending", key });
      void deps
        .send(key)
        .catch((): SendResult => ({ ok: false, message: NOT_SAVED_MESSAGE, failure: "retryable" }))
        .then((r) => {
          inFlight.delete(key);
          if (r.ok) {
            deps.dispatch({ type: "uploaded", key, scanId: r.scanId, at: deps.now() });
            deps.onSaved(key);
          } else {
            deps.dispatch({ type: "uploadFailed", key, message: r.message, failure: r.failure });
            const e = deps.getState().entries.find((x) => x.key === key);
            if (e?.status === "backoff") {
              deps.later(() => {
                deps.dispatch({ type: "retryDue", key });
                pump();
              }, retryDelayMs(e));
            }
          }
          pump();
        });
    }
  }
  return { pump };
}
