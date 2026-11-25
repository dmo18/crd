import type { ScanView } from "@/lib/scans/view";
import { parseCounts, STATUS_POLL_MS, type StatusCounts } from "@/components/nav/scan-status-poll";
import {
  atCap, canRelease, createUploader, emptyQueue, postScan, queuedTooLong, queueReducer, retryKind, scanTimedOut, UPLOAD_TIMEOUT_MS,
  type QueueAction, type QueueEntry, type QueueState, type ScanJob,
} from "./scan-queue";

/**
 * The scan list for the whole signed-in app, kept outside React. It lives in
 * a provider in the (app) layout, so going to another page inside the app
 * never stops an upload or loses a photo; the scan screen only shows it.
 * Everything that touches the browser comes in through `deps`, so tests run
 * it in plain Node.
 */

/** One batched ask for all scans being read, this often, only while the tab is on screen. */
export const POLL_MS = STATUS_POLL_MS;
/** After this many "not signed in" answers in a row the page stops asking. */
export const SIGNED_OUT_AFTER = 3;
const PENDING_KEY = "crd:pending-sends";
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
  /** True while the tab is on screen. */
  isVisible: () => boolean;
  /** Calls `fn` each time the tab is shown or hidden. */
  onVisibilityChange: (fn: () => void) => void;
  uploadTimeoutMs?: number;
  /**
   * Remembers, across a page reload, which photos were sent but not yet confirmed
   * saved. A repeat of the same photo then reuses its clientKey, so the server
   * returns the scan it already has instead of making a second one.
   */
  pending?: { read: () => Record<string, PendingSend>; write: (all: Record<string, PendingSend>) => void };
};

export type PendingSend = { clientKey: string; at: number };
/** A remembered send is forgotten after this long. */
export const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

/** Names one scan by its mode and photos (name and size), for finding a repeat after a reload. */
export function sendFingerprint(job: { mode: string; front?: File; back?: File; source: File[] }): string {
  const files = [job.front, job.back, ...job.source].filter((f): f is File => !!f);
  return `${job.mode}|${files.map((f) => `${f.name}:${f.size}`).join(",")}`;
}

/** What the pill needs: the latest counts, and whether the store is already asking on a timer. */
export type SharedStatus = { counts: StatusCounts | null; polling: boolean; signedOut: boolean };
export const NO_STATUS: SharedStatus = { counts: null, polling: false, signedOut: false };

export type ScanStore = {
  getState: () => QueueState;
  subscribe: (listener: () => void) => () => void;
  /** Puts one scan in the list, to be sent. Returns false only when the list is full of entries that cannot be dropped yet. */
  enqueue: (job: Omit<ScanJob, "clientKey">, preview: Blob, name: string) => boolean;
  /** Retry button: send again if the server never got it, otherwise run the same scan again on the server. */
  retry: (key: number) => Promise<void>;
  /**
   * One batched ask about all saved scans still being read. Runs on its own
   * every 5 seconds while any is being read and the tab is on screen; also
   * the "Check again" button after being signed out.
   */
  poll: () => Promise<void>;
  /** Counts shared with the pill, so the pill does not ask on its own timer while the store asks. */
  getStatus: () => SharedStatus;
  /** The pill's own answer (when the store is not asking). */
  setCounts: (counts: StatusCounts | null) => void;
};

export function createScanStore(deps: ScanStoreDeps): ScanStore {
  let state: QueueState = emptyQueue;
  const listeners = new Set<() => void>();
  const jobs = new Map<number, ScanJob>();
  const previews = new Map<number, string>();
  const fingerprints = new Map<number, string>();
  let asking = false;
  let nextKey = 1;
  let pollTimer: unknown = null;
  let notSignedInRow = 0;
  let signedOut = false;
  let status: SharedStatus = NO_STATUS;

  function setStatus(next: Partial<SharedStatus>) {
    const merged = { ...status, ...next };
    if (merged.counts === status.counts && merged.polling === status.polling && merged.signedOut === status.signedOut) return;
    status = merged;
    for (const l of listeners) l();
  }

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
      forgetPending(key);
      // The server has the photos: let go of the files, keep the preview until it is read.
      const job = jobs.get(key);
      if (job) jobs.set(key, { ...job, front: undefined, back: undefined, source: [] });
      deps.notifySaved();
    },
  });

  const pollable = (e: QueueEntry) => e.status === "reading" && e.scanId !== null;

  function syncPolling() {
    const want = !signedOut && deps.isVisible() && state.entries.some(pollable);
    if (want && pollTimer === null) pollTimer = deps.setInterval(() => void poll(), POLL_MS);
    if (!want && pollTimer !== null) {
      deps.clearInterval(pollTimer);
      pollTimer = null;
    }
    setStatus({ polling: pollTimer !== null, signedOut });
  }

  // Hidden tab: stop asking. Shown again: ask once at once (also after being signed out), then carry on.
  deps.onVisibilityChange(() => {
    if (deps.isVisible() && state.entries.some(pollable)) void poll();
    syncPolling();
  });

  async function poll() {
    if (asking || !deps.isVisible()) return;
    // Give up on a scan the server has been reading for over 6 minutes (server clock),
    // or one still waiting in line 6 minutes after it was saved (page clock). Both then say "taking longer".
    for (const e of state.entries) {
      if (pollable(e) && (scanTimedOut(e.scan) || queuedTooLong(e, deps.now()))) dispatch({ type: "timeout", key: e.key });
    }
    const ids = [...new Set(state.entries.filter(pollable).map((e) => e.scanId as number))];
    if (ids.length === 0) return;
    asking = true;
    try {
      const res = await deps.fetch(`/api/scans/status?ids=${ids.join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (res.status === 401) {
        notSignedInRow += 1;
        if (notSignedInRow >= SIGNED_OUT_AFTER && !signedOut) {
          signedOut = true;
          dispatch({ type: "signedOut", value: true });
        }
        return;
      }
      notSignedInRow = 0;
      if (!res.ok) return;
      const data = (await res.json()) as { scans?: unknown };
      if (signedOut) {
        signedOut = false;
        dispatch({ type: "signedOut", value: false });
      }
      setStatus({ counts: parseCounts(data) ?? status.counts });
      if (Array.isArray(data.scans)) for (const scan of data.scans as ScanView[]) dispatch({ type: "update", scan });
    } catch {
      // A short network blip: try again on the next round.
    } finally {
      asking = false;
      syncPolling();
    }
  }

  function forgetPending(key: number) {
    const fp = fingerprints.get(key);
    fingerprints.delete(key);
    if (fp === undefined || !deps.pending) return;
    const all = deps.pending.read();
    if (fp in all) {
      delete all[fp];
      deps.pending.write(all);
    }
  }

  /** The clientKey for a new scan: one remembered from before a reload for the same photos, else a fresh one. */
  function clientKeyFor(job: Omit<ScanJob, "clientKey">, key: number): string {
    const fp = sendFingerprint(job);
    const live = [...fingerprints.values()].includes(fp);
    fingerprints.set(key, fp);
    if (!deps.pending) return deps.randomUUID();
    const all = deps.pending.read();
    const old = all[fp];
    const fresh = old !== undefined && deps.now() - old.at < PENDING_MAX_AGE_MS && !live;
    const clientKey = fresh ? old.clientKey : deps.randomUUID();
    // Two copies on one page are two scans on purpose; only a repeat after a reload shares a key.
    if (!live) all[fp] = { clientKey, at: fresh ? old.at : deps.now() };
    for (const k of Object.keys(all)) if (deps.now() - all[k].at >= PENDING_MAX_AGE_MS) delete all[k];
    deps.pending.write(all);
    return clientKey;
  }

  function enqueue(job: Omit<ScanJob, "clientKey">, preview: Blob, name: string): boolean {
    // Full list: forget the oldest finished entry (its scan is safe on the server). Nothing unsaved is ever dropped.
    if (atCap(state)) dispatch({ type: "makeRoom" });
    if (atCap(state)) return false;
    const key = nextKey++;
    const clientKey = clientKeyFor(job, key);
    const url = deps.createObjectURL(preview);
    jobs.set(key, { ...job, clientKey });
    previews.set(key, url);
    dispatch({ type: "add", key, clientKey, name, previewUrl: url, batch: job.batchKey ?? null });
    uploader.pump();
    return true;
  }

  async function retry(key: number) {
    const entry = state.entries.find((e) => e.key === key);
    if (!entry) return;
    // A manual Retry after being signed out also checks once whether the owner is back.
    if (signedOut) void poll();
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
      if (res.ok) dispatch({ type: "requeued", key, scan: data, at: deps.now() });
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
    getStatus: () => status,
    setCounts: (counts) => setStatus({ counts }),
  };
}

/** The real browser functions. */
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
    pending: {
      read: () => {
        try {
          const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}") as unknown;
          return v && typeof v === "object" ? (v as Record<string, PendingSend>) : {};
        } catch {
          return {};
        }
      },
      write: (all) => {
        try {
          localStorage.setItem(PENDING_KEY, JSON.stringify(all));
        } catch {
          // Storage can be blocked; a repeat after a reload then gets a new key, as before.
        }
      },
    },
    notifySaved: () => window.dispatchEvent(new Event(SAVED_EVENT)),
    // The store is also made once while the page is built on the server, where there is no document.
    isVisible: () => typeof document !== "undefined" && document.visibilityState === "visible",
    onVisibilityChange: (fn) => {
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", fn);
    },
  };
}
