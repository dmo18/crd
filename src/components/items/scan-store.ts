import type { ScanView } from "@/lib/scans/view";
import {
  atCap, canRelease, createUploader, emptyQueue, postScan, queueReducer, retryKind, scanTimedOut, UPLOAD_TIMEOUT_MS,
  type QueueAction, type QueueState, type ScanJob,
} from "./scan-queue";

/**
 * The scan list for the whole signed-in app, kept outside React. It lives in
 * a provider in the (app) layout, so going to another page inside the app
 * never stops an upload or loses a photo; the scan screen only shows it.
 * Everything that touches the browser comes in through `deps`, so tests run
 * it in plain Node.
 */

export const POLL_MS = 2000;
export const SAVED_EVENT = "crd:scan-saved";
const GONE_MESSAGE = "This photo is no longer on the page. Take it again.";

export type ScanStoreDeps = {
  fetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
  createObjectURL: (file: Blob) => string;
  revokeObjectURL: (url: string) => void;
  randomUUID: () => string;
  /** Called once each time the server has a new scan (fires `crd:scan-saved`). */
  notifySaved: () => void;
  uploadTimeoutMs?: number;
};

export type ScanStore = {
  getState: () => QueueState;
  subscribe: (listener: () => void) => () => void;
  /** Puts one scan in the list, to be sent. Returns false only when the list is full of entries that cannot be dropped yet. */
  enqueue: (job: Omit<ScanJob, "clientKey">, preview: Blob, name: string) => boolean;
  /** Retry button: send again if the server never got it, otherwise run the same scan again on the server. */
  retry: (key: number) => Promise<void>;
  /** One round of asking the server about saved scans (runs on its own every 2 seconds while any is being read). */
  poll: () => Promise<void>;
};

export function createScanStore(deps: ScanStoreDeps): ScanStore {
  let state: QueueState = emptyQueue;
  const listeners = new Set<() => void>();
  const jobs = new Map<number, ScanJob>();
  const previews = new Map<number, string>();
  const asking = new Set<number>();
  let nextKey = 1;
  let pollTimer: unknown = null;

  function dispatch(action: QueueAction) {
    const before = state;
    state = queueReducer(state, action);
    if (state === before) return;
    // Let go of photos the page no longer needs (read, failed on the server, timed out, refused for good).
    for (const e of state.entries) {
      if (!canRelease(e)) continue;
      jobs.delete(e.key);
      const url = previews.get(e.key);
      if (url !== undefined) {
        deps.revokeObjectURL(url);
        previews.delete(e.key);
      }
      if (e.previewUrl !== null) state = queueReducer(state, { type: "released", key: e.key });
    }
    syncPolling();
    for (const l of listeners) l();
  }

  const uploader = createUploader({
    getState: () => state,
    dispatch,
    send: async (key) => {
      const job = jobs.get(key);
      if (!job) return { ok: false, message: GONE_MESSAGE, failure: "final" };
      return postScan(deps.fetch, job, deps.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS);
    },
    later: (fn, ms) => void deps.setTimeout(fn, ms),
    now: deps.now,
    onSaved: (key) => {
      // The server has the photos: let go of the files, keep the preview until it is read.
      const job = jobs.get(key);
      if (job) jobs.set(key, { ...job, front: undefined, back: undefined, source: [] });
      deps.notifySaved();
    },
  });

  function syncPolling() {
    const want = state.entries.some((e) => e.status === "reading");
    if (want && pollTimer === null) pollTimer = deps.setInterval(() => void poll(), POLL_MS);
    if (!want && pollTimer !== null) {
      deps.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function poll() {
    const reading = state.entries.filter((e) => e.status === "reading" && e.scanId !== null);
    await Promise.all(
      reading.map(async (e) => {
        // Only a scan the server has been reading for over 6 minutes is given up on;
        // one waiting in line keeps being checked.
        if (scanTimedOut(e.scan)) {
          dispatch({ type: "timeout", key: e.key });
          return;
        }
        if (asking.has(e.key)) return;
        asking.add(e.key);
        try {
          const res = await deps.fetch(`/api/scans/${e.scanId}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
          if (!res.ok) return;
          dispatch({ type: "update", scan: (await res.json()) as ScanView });
        } catch {
          // A short network blip: try again on the next round.
        } finally {
          asking.delete(e.key);
        }
      }),
    );
  }

  function enqueue(job: Omit<ScanJob, "clientKey">, preview: Blob, name: string): boolean {
    // Full list: forget the oldest finished entry (its scan is safe on the server). Nothing unsaved is ever dropped.
    if (atCap(state)) dispatch({ type: "makeRoom" });
    if (atCap(state)) return false;
    const key = nextKey++;
    const clientKey = deps.randomUUID();
    const url = deps.createObjectURL(preview);
    jobs.set(key, { ...job, clientKey });
    previews.set(key, url);
    dispatch({ type: "add", key, clientKey, name, previewUrl: url });
    uploader.pump();
    return true;
  }

  async function retry(key: number) {
    const entry = state.entries.find((e) => e.key === key);
    if (!entry) return;
    const kind = retryKind(entry);
    if (kind === "upload") {
      if (!jobs.has(key)) return;
      dispatch({ type: "retry", key });
      uploader.pump();
      return;
    }
    if (kind !== "server" || entry.scanId === null) return;
    try {
      const res = await deps.fetch(`/api/scans/${entry.scanId}/retry`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      const data = (await res.json().catch(() => null)) as (ScanView & { error?: string }) | null;
      if (res.ok) dispatch({ type: "requeued", key, scan: data });
      else dispatch({ type: "retryError", key, message: data?.error ?? "Could not try again. Please try later." });
    } catch {
      dispatch({ type: "retryError", key, message: "Could not reach the server. Check your connection and try again." });
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueue,
    retry,
    poll,
  };
}

/** The real browser functions. Only called in the browser. */
export function browserDeps(): ScanStoreDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    now: () => Date.now(),
    createObjectURL: (file) => URL.createObjectURL(file),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    randomUUID: () => crypto.randomUUID(),
    notifySaved: () => window.dispatchEvent(new Event(SAVED_EVENT)),
  };
}
