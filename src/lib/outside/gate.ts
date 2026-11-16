import { getDb, type Db } from "@/db";
import { log } from "@/lib/log";
import { CACHE_CAP_BYTES, cacheKey, getCached, pruneCache, putCached, type CacheKind } from "./cache";
import { openKey } from "./keys";
import { SOURCES, sourceAvailable, type OutsideRequest, type SourceConfig, type SourceId } from "./sources";
import { bumpUsage, getSourceState, pauseSource, recordError, recordOk, usageOn, utcDay } from "./usage";

/**
 * The shared gate: every call that leaves the server goes through
 * `outsideCall`. It keeps one call at a time (all sources together), the
 * pause between call starts, the hour and day caps, the two lines (`now`
 * before `background`), timeouts, extra tries with backoff, the stored
 * "slow down" pause, counters and stored answers.
 * Design: docs/PLAN.md, Milestone 10, "the shared gate for outside calls".
 *
 * Logs carry only source, kind, status and errorKind: never a URL, a
 * header, a key or a body.
 */

/** Time source, injectable so tests run on a fake clock. */
export type Clock = {
  now(): number;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export type Line = "now" | "background";

export type CallOptions = {
  /** `now`: the owner is looking at a screen. `background`: scans. Default background. */
  line?: Line;
  /** Use and keep a stored answer. `kindOf` says how to keep the answer, or null to not keep it. */
  cache?: { args: Record<string, string | number | boolean | null | undefined>; kindOf: (body: string) => CacheKind | null };
  /** Overrides the source's timeout (a checklist gets 10 s). At most 10 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Which database (and so which gate) to use. Default: the app's. */
  db?: Db;
};

export type OutsideFailure =
  | "off" | "needs_key" | "paused" | "capped" | "busy" | "timeout" | "network" | "server" | "http"
  | "slow_down" | "too_large" | "redirect" | "bad_request";

export type OutsideResult =
  | { ok: true; status: number; body: string; fromStore: boolean; ms: number }
  | { ok: false; reason: OutsideFailure; status: number | null; message: string; errorKind: string; retryAt: Date | null };

/** A `now` call that cannot start within this time gives up. */
export const NOW_WAIT_MS = 8000;
/** Calls that fail in a row before the source is paused, and for how long. */
export const FAILS_BEFORE_PAUSE = 3;
export const FAIL_PAUSE_MS = 10 * 60 * 1000;
/** Random spread added to each retry wait. */
export const RETRY_SPREAD_MS = 500;
const MAX_TIMEOUT_MS = 10_000;
const MIN_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PRUNE_EVERY_MS = HOUR_MS;

const MESSAGES: Record<OutsideFailure, string> = {
  off: "This source is switched off.",
  needs_key: "This source needs a key.",
  paused: "The site asked us to slow down. Try again later.",
  capped: "The limit of calls for now is reached. Try again later.",
  busy: "The catalog is busy. Try again in a moment.",
  timeout: "The site did not answer in time.",
  network: "Could not reach the site.",
  server: "The site had a problem.",
  http: "The site refused the request.",
  slow_down: "The site asked us to slow down.",
  too_large: "The answer was too large.",
  redirect: "The site tried to send us to another address.",
  bad_request: "The request was not valid.",
};

const ERROR_KINDS: Record<OutsideFailure, string> = {
  off: "Off", needs_key: "NeedsKey", paused: "Paused", capped: "Capped", busy: "Busy", timeout: "Timeout",
  network: "NetworkError", server: "ServerError", http: "HttpError", slow_down: "RateLimited",
  too_large: "TooLarge", redirect: "Redirect", bad_request: "BadRequest",
};

function fail(reason: OutsideFailure, status: number | null = null, retryAt: Date | null = null): OutsideResult {
  return { ok: false, reason, status, message: MESSAGES[reason], errorKind: ERROR_KINDS[reason], retryAt };
}

const TOOL = /^[A-Za-z0-9_.-]{1,40}$/;
const PATH = /^\/[A-Za-z0-9._~/-]{0,200}$/;

/** Builds the address from the source's fixed host. Throws on anything unexpected. */
function buildRequest(src: SourceConfig, req: OutsideRequest): { url: string; init: RequestInit } {
  const host = req.host ?? src.hosts[0];
  if (!src.hosts.includes(host)) throw new Error("host");
  if (!TOOL.test(req.tool) || !PATH.test(req.path) || req.path.includes("//") || req.path.includes("..")) throw new Error("path");
  const url = new URL(`https://${host}${req.path}`);
  if (url.protocol !== "https:" || url.hostname !== host) throw new Error("host");
  if (req.query) url.search = new URLSearchParams(req.query).toString();
  const method = req.method ?? "GET";
  const headers: Record<string, string> = { "User-Agent": src.userAgent(), Accept: req.accept ?? "application/json" };
  let body: string | undefined;
  if (req.json !== undefined) {
    if (method !== "POST") throw new Error("method");
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  // Redirects are refused and cookies are never sent or kept.
  return { url: url.toString(), init: { method, headers, body, redirect: "manual", credentials: "omit", cache: "no-store" } };
}

/** Retry-After is seconds or an HTTP date; kept between 1 second and 1 hour. */
function retryAfterMs(value: string | null, nowMs: number, fallback: number): number {
  if (value) {
    const v = value.trim();
    if (/^\d+$/.test(v)) return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Number(v) * 1000));
    const at = Date.parse(v);
    if (Number.isFinite(at)) return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, at - nowMs));
  }
  return fallback;
}

type Attempt =
  | { kind: "ok"; status: number; body: string }
  | { kind: "slow_down"; status: number; pauseMs: number }
  | { kind: "timeout" | "network" }
  | { kind: "server" | "http" | "redirect" | "too_large"; status: number };

/** Reads at most `max` bytes; null when the answer is larger. */
async function readLimited(res: Response, max: number, abort: () => void): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    abort();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Waiter = { source: SourceId; line: Line; grant: (ok: boolean) => void; cancelDeadline: (() => void) | null };

export type GateDeps = {
  db: Db;
  clock?: Clock;
  fetch?: typeof fetch;
  /** 0 to 1; the retry spread. */
  random?: () => number;
  cacheCapBytes?: number;
};

/** Tests never reach the network: without an injected fetch nothing is sent. */
const noFetchInTests: typeof fetch = async () => {
  throw Object.assign(new Error("no network in tests"), { name: "NotInTests" });
};

export class Gate {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly cacheCapBytes: number;
  private readonly queue: Waiter[] = [];
  private busy = false;
  private readonly lastStart = new Map<SourceId, number>();
  /** Call starts in the last hour, in memory only (a restart counts from 0, the day cap still holds). */
  private readonly hourStarts = new Map<SourceId, number[]>();
  private readonly failStreak = new Map<SourceId, number>();
  private lastPrune: number | null = null;
  private cancelPump: (() => void) | null = null;

  constructor(deps: GateDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? realClock;
    this.fetchImpl = deps.fetch ?? (process.env.VITEST ? noFetchInTests : (input, init) => fetch(input, init));
    this.random = deps.random ?? Math.random;
    this.cacheCapBytes = deps.cacheCapBytes ?? CACHE_CAP_BYTES;
  }

  /** Calls this hour for one source (for the usage view). */
  callsThisHour(source: SourceId): number {
    return this.recentStarts(source).length;
  }

  private recentStarts(source: SourceId): number[] {
    const since = this.clock.now() - HOUR_MS;
    const list = (this.hourStarts.get(source) ?? []).filter((t) => t > since);
    this.hourStarts.set(source, list);
    return list;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimer(ms, resolve));
  }

  // ---------- one call at a time, pacing, two lines ----------

  private readyAt(source: SourceId): number {
    const last = this.lastStart.get(source);
    return last === undefined ? -Infinity : last + SOURCES[source].minGapMs;
  }

  private pump(): void {
    this.cancelPump?.();
    this.cancelPump = null;
    if (this.busy || this.queue.length === 0) return;
    const now = this.clock.now();
    const ready = this.queue.filter((w) => this.readyAt(w.source) <= now);
    const next = ready.find((w) => w.line === "now") ?? ready[0];
    if (next) {
      this.queue.splice(this.queue.indexOf(next), 1);
      next.cancelDeadline?.();
      this.busy = true;
      this.lastStart.set(next.source, now);
      next.grant(true);
      return;
    }
    const soonest = Math.min(...this.queue.map((w) => this.readyAt(w.source)));
    this.cancelPump = this.clock.setTimer(Math.max(0, soonest - now), () => this.pump());
  }

  /** Waits for the one slot. False when a `now` call could not start in time. */
  private acquire(source: SourceId, line: Line, giveUpAfterMs: number | null): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: Waiter = { source, line, grant: resolve, cancelDeadline: null };
      if (giveUpAfterMs !== null) {
        waiter.cancelDeadline = this.clock.setTimer(giveUpAfterMs, () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            resolve(false);
            this.pump();
          }
        });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  private release(): void {
    this.busy = false;
    this.pump();
  }

  // ---------- switch, pause, caps ----------

  /** Why a call to this source may not start now, or null. A cap counts as skipped. */
  private blocked(source: SourceId, nowMs: number): OutsideResult | null {
    const src = SOURCES[source];
    const state = getSourceState(this.db, source);
    if (!state.enabled) return fail("off");
    if (state.pausedUntil && state.pausedUntil.getTime() > nowMs) return fail("paused", null, state.pausedUntil);
    const overHour = src.perHour !== null && this.recentStarts(source).length >= src.perHour;
    const overDay = src.perDay !== null && usageOn(this.db, source, utcDay(nowMs)).calls >= src.perDay;
    if (overHour || overDay) {
      bumpUsage(this.db, source, nowMs, { skipped: 1 });
      return fail("capped");
    }
    return null;
  }

  private pause(source: SourceId, tool: string, ms: number, reason: string, status: number | null, errorKind: string): Date {
    const now = this.clock.now();
    pauseSource(this.db, source, now + ms, reason, now);
    log.warn("outside_paused", { source, kind: tool, status, errorKind });
    return new Date(now + ms);
  }

  // ---------- one network attempt ----------

  private async attempt(
    src: SourceConfig, url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch,
    secretHeader: Record<string, string> | null = null,
  ): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelTimer: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancelTimer = this.clock.setTimer(timeoutMs, () => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
      });
    });
    timeout.catch(() => undefined);
    try {
      // The last step: the key joins the headers only for the fetch itself.
      const headers = secretHeader ? { ...(init.headers as Record<string, string>), ...secretHeader } : init.headers;
      const res = await Promise.race([fetchImpl(url, { ...init, headers, signal: controller.signal }), timeout]);
      const status = res.status;
      const discard = () => { res.body?.cancel().catch(() => undefined); };
      if ((status >= 300 && status < 400) || res.type === "opaqueredirect") {
        discard();
        return { kind: "redirect", status };
      }
      const retryAfter = res.headers.get("retry-after");
      if (status === 429 || (status === 403 && src.pauseOn403) || (status === 503 && src.pauseOn503WithRetryAfter && retryAfter)) {
        discard();
        return { kind: "slow_down", status, pauseMs: retryAfterMs(retryAfter, this.clock.now(), src.defaultPauseMs) };
      }
      if (status >= 500) {
        discard();
        return { kind: "server", status };
      }
      if (status < 200 || status >= 300) {
        discard();
        return { kind: "http", status };
      }
      const body = await Promise.race([readLimited(res, src.maxBytes, () => controller.abort()), timeout]);
      if (body === null) return { kind: "too_large", status };
      return { kind: "ok", status, body };
    } catch {
      return { kind: timedOut ? "timeout" : "network" };
    } finally {
      cancelTimer();
    }
  }

  // ---------- the call ----------

  async call(source: SourceId, request: OutsideRequest, options: CallOptions = {}): Promise<OutsideResult> {
    const src = SOURCES[source];
    const db = this.db;
    const line = options.line ?? "background";
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? src.timeoutMs));
    const fetchImpl = options.fetchImpl ?? this.fetchImpl;
    const startedAll = this.clock.now();

    let built: { url: string; init: RequestInit };
    try {
      built = buildRequest(src, request);
    } catch {
      return fail("bad_request");
    }
    if (!sourceAvailable(source) || !getSourceState(db, source).enabled) return fail("off");
    // A source with a key: opened here, inside the server, at call time. It is
    // added to the request only in `attempt`, and never logged or returned.
    let secretHeader: Record<string, string> | null = null;
    if (src.needsKey) {
      const k = src.key ? openKey(db, source) : null;
      if (!src.key || k === null) return fail("needs_key");
      secretHeader = { [src.key.header]: k };
    }

    const key = options.cache ? cacheKey(source, request.tool, options.cache.args) : null;
    if (key) {
      const hit = getCached(db, key, this.clock.now());
      if (hit) {
        bumpUsage(db, source, this.clock.now(), { storeHits: 1 });
        return { ok: true, status: 200, body: hit.body, fromStore: true, ms: 0 };
      }
    }

    for (let tryNo = 0; ; tryNo++) {
      const before = this.blocked(source, this.clock.now());
      if (before) return before;

      const queuedAt = this.clock.now();
      const got = await this.acquire(source, line, tryNo === 0 && line === "now" ? NOW_WAIT_MS : null);
      const startAt = this.clock.now();
      if (!got) {
        bumpUsage(db, source, startAt, { waitMs: startAt - queuedAt });
        return fail("busy");
      }

      let result: Attempt;
      try {
        const atStart = this.blocked(source, startAt);
        if (atStart) return atStart;
        this.recentStarts(source).push(startAt);
        bumpUsage(db, source, startAt, { calls: 1, waitMs: startAt - queuedAt });
        result = await this.attempt(src, built.url, built.init, timeoutMs, fetchImpl, secretHeader);
      } finally {
        this.release();
      }

      const now = this.clock.now();
      if (result.kind === "ok") {
        this.failStreak.set(source, 0);
        recordOk(db, source, now);
        const kind = options.cache?.kindOf(result.body) ?? null;
        if (key && kind) this.store(key, source, kind, result.body, now);
        return { ok: true, status: result.status, body: result.body, fromStore: false, ms: now - startedAll };
      }

      if (result.kind === "slow_down") {
        bumpUsage(db, source, now, { errors: 1, slowDowns: 1 });
        const until = this.pause(source, request.tool, result.pauseMs, "The site asked us to slow down", result.status, "RateLimited");
        return fail("slow_down", result.status, until);
      }

      bumpUsage(db, source, now, { errors: 1 });
      const status = "status" in result ? result.status : null;
      const retryable = result.kind === "timeout" || result.kind === "network" || result.kind === "server";
      if (retryable && tryNo < src.retryDelaysMs.length) {
        await this.sleep(src.retryDelaysMs[tryNo] + Math.floor(this.random() * RETRY_SPREAD_MS));
        continue;
      }

      recordError(db, source, MESSAGES[result.kind], now);
      if (result.kind === "redirect" || result.kind === "too_large") {
        log.warn("outside_refused", { source, kind: request.tool, status, errorKind: ERROR_KINDS[result.kind] });
      }
      if (retryable) {
        const streak = (this.failStreak.get(source) ?? 0) + 1;
        this.failStreak.set(source, streak);
        if (streak >= FAILS_BEFORE_PAUSE) {
          this.failStreak.set(source, 0);
          this.pause(source, request.tool, FAIL_PAUSE_MS, "Three calls failed in a row", status, ERROR_KINDS[result.kind]);
        }
      }
      return fail(result.kind, status);
    }
  }

  /** Keeps an answer; prunes old ones on write, at most once an hour. */
  private store(key: string, source: SourceId, kind: CacheKind, body: string, nowMs: number): void {
    try {
      putCached(this.db, { key, source, kind, body, nowMs });
      if (this.lastPrune === null || nowMs - this.lastPrune >= PRUNE_EVERY_MS) {
        this.lastPrune = nowMs;
        pruneCache(this.db, nowMs, this.cacheCapBytes);
      }
    } catch {
      // A store problem must not break the call.
    }
  }
}

export function createGate(deps: GateDeps): Gate {
  return new Gate(deps);
}

/** One gate per database: in the app there is one, tests get a fresh one per test database. */
const gates = new WeakMap<Db, Gate>();

export function gateFor(db: Db): Gate {
  let gate = gates.get(db);
  if (!gate) {
    gate = new Gate({ db });
    gates.set(db, gate);
  }
  return gate;
}

/** The one way to call an outside address. Never throws for network trouble; check `ok`. */
export function outsideCall(source: SourceId, request: OutsideRequest, options: CallOptions = {}): Promise<OutsideResult> {
  return gateFor(options.db ?? getDb()).call(source, request, options);
}
