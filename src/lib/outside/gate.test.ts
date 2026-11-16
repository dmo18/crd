import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { outsideCache, outsideState, outsideUsage } from "@/db/schema";
import { setLogSink } from "@/lib/log";
import { createGate, FAIL_PAUSE_MS, gateFor, NOW_DEADLINE_MS, type CallOptions, type Clock } from "./gate";
import { requestKey } from "./cache";
import { appUserAgent, SOURCES, type OutsideRequest } from "./sources";
import { getSourceState, setSourceEnabled, usageOn, utcDay } from "./usage";

/** A clock that only moves when the test says so. */
class FakeClock implements Clock {
  t = Date.parse("2026-11-16T10:00:00Z");
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;
  now() {
    return this.t;
  }
  setTimer(ms: number, fn: () => void) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  }
  /** Moves time forward, firing timers in order and letting promises settle between them. */
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

const SEARCH: OutsideRequest = {
  tool: "search_cards", path: "/api/mcp", method: "POST", accept: "application/json, text/event-stream",
  json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_cards", arguments: { query: "x", limit: 1 } } },
};

/** The search request for these words, as MyCardfolio's client sends it. */
const searchFor = (query: string, limit = 1): OutsideRequest => ({
  ...SEARCH,
  json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_cards", arguments: { query, limit } } },
});

/** A fetch that never answers: each try ends only by its timeout. */
const hangingFetch = (): FakeFetch =>
  vi.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));

type FakeFetch = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

function okFetch(body = '{"ok":true}'): FakeFetch {
  return vi.fn(async () => new Response(body, { status: 200 }));
}

function setup(fetchImpl: FakeFetch, db: Db = createDb(":memory:"), clock = new FakeClock(), extra: { cacheCapBytes?: number } = {}) {
  const gate = createGate({ db, clock, fetch: fetchImpl as unknown as typeof fetch, random: () => 0, ...extra });
  return { db, clock, gate };
}

const today = (clock: FakeClock) => utcDay(clock.now());

afterEach(() => setLogSink());

describe("one call at a time and pacing", () => {
  it("runs 5 parallel requests one at a time, at least 2 s apart", async () => {
    let running = 0;
    let most = 0;
    const starts: number[] = [];
    const clockRef: { c?: FakeClock } = {};
    const f: FakeFetch = vi.fn(async () => {
      running++;
      most = Math.max(most, running);
      starts.push(clockRef.c!.now());
      await Promise.resolve();
      running--;
      return new Response("{}", { status: 200 });
    });
    const { gate, clock } = setup(f);
    clockRef.c = clock;
    const all = Promise.all(Array.from({ length: 5 }, () => gate.call("mycardfolio", SEARCH)));
    await clock.advance(10_000);
    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(most).toBe(1);
    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(2000);
    expect(starts[1] - starts[0]).toBe(2000);
  });

  it("holds all sources together to one call at a time", async () => {
    let release: () => void = () => undefined;
    const f: FakeFetch = vi.fn(() => new Promise<Response>((r) => { release = () => r(new Response("{}", { status: 200 })); }));
    const { gate, clock } = setup(f);
    const a = gate.call("mycardfolio", SEARCH);
    const b = gate.call("wikidata", SOURCES.wikidata.testCall);
    await clock.advance(1000);
    expect(f).toHaveBeenCalledTimes(1);
    release();
    await clock.advance(10);
    expect(f).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([a, b]);
  });

  it("sends the fixed host, the app User-Agent, no cookies, and refuses to follow redirects", async () => {
    const f = okFetch();
    const { gate } = setup(f);
    await gate.call("mycardfolio", SEARCH);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://mycardfolio.com/api/mcp");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(appUserAgent());
    expect(appUserAgent()).toMatch(/^CardVault\/\d+\.\d+\.\d+$/);
  });

  it("refuses a host or path that is not the source's", async () => {
    const f = okFetch();
    const { gate } = setup(f);
    expect(await gate.call("mycardfolio", { ...SEARCH, host: "evil.example" })).toMatchObject({ ok: false, reason: "bad_request" });
    expect(await gate.call("mycardfolio", { ...SEARCH, path: "//evil.example/x" })).toMatchObject({ ok: false, reason: "bad_request" });
    expect(await gate.call("mycardfolio", { ...SEARCH, path: "/a/../b" })).toMatchObject({ ok: false, reason: "bad_request" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("caps", () => {
  it("stops at 200 calls in an hour and starts again when the hour has passed", async () => {
    const f = okFetch();
    const { gate, clock, db } = setup(f);
    for (let i = 0; i < 200; i++) {
      const p = gate.call("mycardfolio", SEARCH);
      await clock.advance(2000);
      expect((await p).ok).toBe(true);
    }
    const capped = await gate.call("mycardfolio", SEARCH);
    expect(capped).toMatchObject({ ok: false, reason: "capped" });
    expect(f).toHaveBeenCalledTimes(200);
    expect(gate.callsThisHour("mycardfolio")).toBe(200);
    expect(usageOn(db, "mycardfolio", today(clock))).toMatchObject({ calls: 200, skipped: 1 });
    await clock.advance(60 * 60 * 1000);
    expect((await gate.call("mycardfolio", SEARCH)).ok).toBe(true);
  });

  it("keeps the day cap of 1,000 across a restart", async () => {
    const db = createDb(":memory:");
    const clock = new FakeClock();
    db.insert(outsideUsage).values({ source: "mycardfolio", day: today(clock), calls: 999 }).run();
    const f = okFetch();
    const first = setup(f, db, clock).gate;
    expect((await first.call("mycardfolio", SEARCH)).ok).toBe(true);
    // A restart: a new gate on the same database, hour counts start from 0.
    const second = setup(f, db, clock).gate;
    await clock.advance(5000);
    expect(await second.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "capped" });
    expect(f).toHaveBeenCalledTimes(1);
    // The next UTC day starts fresh.
    await clock.advance(24 * 60 * 60 * 1000);
    expect((await second.call("mycardfolio", SEARCH)).ok).toBe(true);
  });
});

describe("the two lines", () => {
  it("starts a waiting now call before a waiting background call", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const f: FakeFetch = vi.fn((input, init) => {
      order.push(JSON.parse(String(init?.body)).id);
      return new Promise<Response>((r) => { release = () => r(new Response("{}", { status: 200 })); });
    });
    const { gate, clock } = setup(f);
    const req = (id: string): OutsideRequest => ({ ...SEARCH, json: { id } });
    const first = gate.call("mycardfolio", req("first"));
    await clock.advance(10);
    const bg = gate.call("mycardfolio", req("background"));
    const now = gate.call("mycardfolio", req("now"), { line: "now" });
    await clock.advance(10);
    release();
    await clock.advance(2000);
    release();
    await clock.advance(2000);
    release();
    await Promise.all([first, bg, now]);
    expect(order).toEqual(["first", "now", "background"]);
  });

  it("a now call has one 12 s deadline for queue and try together, then the plain busy message", async () => {
    const f = hangingFetch();
    const { gate, clock } = setup(f);
    const slow = gate.call("mycardfolio", { ...SEARCH, safeToRepeat: false }, { timeoutMs: 10_000 });
    let done = false;
    const now = gate.call("mycardfolio", SEARCH, { line: "now" }).finally(() => { done = true; });
    // 10 s in the queue behind the slow call, then its own try is cut at 12 s.
    await clock.advance(NOW_DEADLINE_MS - 1);
    expect(done).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    await clock.advance(1);
    expect(await now).toMatchObject({ ok: false, reason: "busy", message: "The catalog is busy. Try again in a moment." });
    expect(await slow).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("a now call that is still waiting in the queue at 12 s gives up without being sent", async () => {
    const f = hangingFetch();
    const { gate, clock } = setup(f);
    // Wikidata holds the slot 10 s; then the first now call takes it until its own deadline.
    const blocker = gate.call("wikidata", SOURCES.wikidata.testCall, { timeoutMs: 10_000 });
    const first = gate.call("mycardfolio", SEARCH, { line: "now" });
    const second = gate.call("mycardfolio", SEARCH, { line: "now" });
    await clock.advance(NOW_DEADLINE_MS + 1000);
    expect(await blocker).toMatchObject({ ok: false, reason: "timeout" });
    expect(await first).toMatchObject({ ok: false, reason: "busy" });
    expect(await second).toMatchObject({ ok: false, reason: "busy" });
    // The second one never reached the site.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a now call counts tries and the waits between them in the same 12 s", async () => {
    const starts: number[] = [];
    const ref: { c?: FakeClock } = {};
    const hang = hangingFetch();
    const f: FakeFetch = vi.fn((u: RequestInfo | URL, init?: RequestInit) => { starts.push(ref.c!.now()); return hang(u, init); });
    const { gate, clock } = setup(f);
    ref.c = clock;
    const t0 = clock.now();
    let doneAt = 0;
    const now = gate.call("mycardfolio", SEARCH, { line: "now" }).finally(() => { doneAt = clock.now(); });
    await clock.advance(60_000);
    // Try at 0 (5 s), wait 2 s, try at 7 s (5 s): the next wait of 8 s would pass 12 s.
    expect(starts.map((t) => t - t0)).toEqual([0, 7000]);
    expect(await now).toMatchObject({ ok: false, reason: "busy", message: "The catalog is busy. Try again in a moment." });
    expect(doneAt - t0).toBe(NOW_DEADLINE_MS);
  });

  it("a background call keeps all its tries and waits", async () => {
    const f = hangingFetch();
    const { gate, clock } = setup(f);
    const t0 = clock.now();
    let doneAt = 0;
    const p = gate.call("mycardfolio", SEARCH).finally(() => { doneAt = clock.now(); });
    await clock.advance(60_000);
    expect(await p).toMatchObject({ ok: false, reason: "timeout" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(doneAt - t0).toBe(5000 + 2000 + 5000 + 8000 + 5000);
  });
});

describe("retry and backoff", () => {
  it("tries a 500 two more times after 2 s and 8 s, then stops", async () => {
    const starts: number[] = [];
    const ref: { c?: FakeClock } = {};
    const f: FakeFetch = vi.fn(async () => { starts.push(ref.c!.now()); return new Response("oops", { status: 500 }); });
    const { gate, clock, db } = setup(f);
    ref.c = clock;
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(20_000);
    expect(await p).toMatchObject({ ok: false, reason: "server", status: 500 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(starts.map((t) => t - starts[0])).toEqual([0, 2000, 10_000]);
    expect(usageOn(db, "mycardfolio", today(clock))).toMatchObject({ calls: 3, errors: 3 });
  });

  it("tries a timeout two more times, then stops", async () => {
    const f: FakeFetch = vi.fn((_u, init) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    const { gate, clock } = setup(f);
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(60_000);
    expect(await p).toMatchObject({ ok: false, reason: "timeout", errorKind: "Timeout" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("retries only a request that is safe to repeat (MyCardfolio's MCP reads are)", async () => {
    setLogSink(() => undefined);
    const run = async (req: OutsideRequest) => {
      const f: FakeFetch = vi.fn(async () => new Response("oops", { status: 500 }));
      const { gate, clock } = setup(f);
      const p = gate.call("mycardfolio", req);
      await clock.advance(20_000);
      expect(await p).toMatchObject({ ok: false, reason: "server" });
      return f.mock.calls.length;
    };
    expect(SOURCES.mycardfolio.repeatSafeTools).toEqual(["search_cards", "get_card", "get_set_checklist"]);
    for (const tool of SOURCES.mycardfolio.repeatSafeTools) expect(await run({ ...SEARCH, tool })).toBe(3);
    // A tool not on the list, or a request marked not safe, gets one try only.
    expect(await run({ ...SEARCH, tool: "save_card" })).toBe(1);
    expect(await run({ ...SEARCH, safeToRepeat: false })).toBe(1);
    expect(await run({ ...SEARCH, tool: "save_card", safeToRepeat: true })).toBe(3);
  });

  it("does not retry other 4xx answers", async () => {
    const f: FakeFetch = vi.fn(async () => new Response("no", { status: 404 }));
    const { gate, clock } = setup(f);
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(20_000);
    expect(await p).toMatchObject({ ok: false, reason: "http", status: 404 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("slow down and pauses", () => {
  it("a 429 with Retry-After pauses for that time, without retry", async () => {
    setLogSink(() => undefined);
    const f: FakeFetch = vi.fn(async () => new Response("slow", { status: 429, headers: { "Retry-After": "120" } }));
    const { gate, clock, db } = setup(f);
    const r = await gate.call("mycardfolio", SEARCH);
    expect(r).toMatchObject({ ok: false, reason: "slow_down", status: 429 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(getSourceState(db, "mycardfolio").pausedUntil?.getTime()).toBe(clock.now() + 120_000);
    expect(usageOn(db, "mycardfolio", today(clock))).toMatchObject({ slowDowns: 1 });
    await clock.advance(119_000);
    expect(await gate.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "paused" });
    expect(f).toHaveBeenCalledTimes(1);
    await clock.advance(1000);
    await gate.call("mycardfolio", SEARCH);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a 429 without Retry-After pauses for 15 minutes; Retry-After is kept between 1 s and 1 hour", async () => {
    setLogSink(() => undefined);
    const cases: [Record<string, string>, number][] = [[{}, 15 * 60_000], [{ "Retry-After": "0" }, 1000], [{ "Retry-After": "99999" }, 3_600_000]];
    for (const [headers, ms] of cases) {
      const { gate, clock, db } = setup(vi.fn(async () => new Response("", { status: 429, headers })));
      await gate.call("mycardfolio", SEARCH);
      expect(getSourceState(db, "mycardfolio").pausedUntil?.getTime()).toBe(clock.now() + ms);
    }
  });

  it("a 403 from the front door pauses MyCardfolio too", async () => {
    setLogSink(() => undefined);
    const { gate, db } = setup(vi.fn(async () => new Response("", { status: 403 })));
    expect(await gate.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "slow_down", status: 403 });
    expect(getSourceState(db, "mycardfolio").pausedUntil).not.toBeNull();
  });

  it("three failed tries in a row pause the source for 10 minutes: each try counts", async () => {
    setLogSink(() => undefined);
    let lastTry = 0;
    const ref: { c?: FakeClock } = {};
    const f: FakeFetch = vi.fn(async () => { lastTry = ref.c!.now(); throw new TypeError("fetch failed"); });
    const { gate, clock, db } = setup(f);
    ref.c = clock;
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(20_000);
    expect(await p).toMatchObject({ ok: false, reason: "network" });
    expect(f).toHaveBeenCalledTimes(3);
    const state = getSourceState(db, "mycardfolio");
    expect(state.pausedUntil?.getTime()).toBe(lastTry + FAIL_PAUSE_MS);
    expect(state.lastError).toBe("Three calls failed in a row");
    expect(await gate.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "paused" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("any answer from the server, even a 4xx, ends the streak; 5xx, timeout and network failures add to it", async () => {
    setLogSink(() => undefined);
    // net, 500 (2 in a row), 404 ends it, net, 503 (2), 400 ends it, 502, net (2), net (3: pause).
    const plan: (number | "net")[] = ["net", 500, 404, "net", 503, 400, 502, "net", "net"];
    const f: FakeFetch = vi.fn(async () => {
      const next = plan.shift();
      if (next === "net") throw new TypeError("fetch failed");
      return new Response("", { status: next });
    });
    const { gate, clock, db } = setup(f);
    const once: OutsideRequest = { ...SEARCH, safeToRepeat: false };
    for (let i = 0; i < 8; i++) {
      const p = gate.call("mycardfolio", once);
      await clock.advance(2000);
      await p;
    }
    expect(f).toHaveBeenCalledTimes(8);
    expect(getSourceState(db, "mycardfolio").pausedUntil).toBeNull();
    const last = gate.call("mycardfolio", once);
    await clock.advance(2000);
    expect(await last).toMatchObject({ ok: false, reason: "network" });
    expect(getSourceState(db, "mycardfolio").pausedUntil).not.toBeNull();
  });

  it("a timeout adds to the streak too", async () => {
    setLogSink(() => undefined);
    const f = hangingFetch();
    const { gate, clock, db } = setup(f);
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(60_000);
    expect(await p).toMatchObject({ ok: false, reason: "timeout" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(getSourceState(db, "mycardfolio").lastError).toBe("Three calls failed in a row");
  });

  it("a pause survives a restart", async () => {
    setLogSink(() => undefined);
    const db = createDb(":memory:");
    const clock = new FakeClock();
    await setup(vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "600" } })), db, clock).gate.call("mycardfolio", SEARCH);
    const f = okFetch();
    const restarted = setup(f, db, clock).gate;
    expect(await restarted.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "paused" });
    expect(f).not.toHaveBeenCalled();
    await clock.advance(600_000);
    expect((await restarted.call("mycardfolio", SEARCH)).ok).toBe(true);
  });
});

describe("stored answers", () => {
  const keep = (kind: "search" | "search_empty" | "card" = "search"): CallOptions => ({ cache: { kindOf: () => kind } });

  it("uses a stored answer without counting a call; only the search words are folded", async () => {
    const f = okFetch('{"results":[1]}');
    const { gate, clock, db } = setup(f);
    const a = await gate.call("mycardfolio", searchFor("1990 Topps Griffey"), keep());
    const b = await gate.call("mycardfolio", searchFor("  1990 TOPPS griffey "), keep());
    expect(a).toMatchObject({ ok: true, fromStore: false });
    expect(b).toMatchObject({ ok: true, fromStore: true, body: '{"results":[1]}' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(usageOn(db, "mycardfolio", today(clock))).toMatchObject({ calls: 1, storeHits: 1 });
  });

  it("keys on the request actually sent, not on cache.args", async () => {
    const f = okFetch('{"results":[1]}');
    const { gate, clock } = setup(f);
    // Same args, different requests (limit 1 and 20): two calls.
    await gate.call("mycardfolio", searchFor("Griffey", 1), { cache: { args: { query: "Griffey" }, kindOf: () => "search" } });
    const other = gate.call("mycardfolio", searchFor("Griffey", 20), { cache: { args: { query: "Griffey" }, kindOf: () => "search" } });
    await clock.advance(2000);
    expect(await other).toMatchObject({ fromStore: false });
    expect(f).toHaveBeenCalledTimes(2);
    // Same request, other args: the stored answer.
    expect(await gate.call("mycardfolio", searchFor("Griffey", 1), { cache: { args: { anything: "else" }, kindOf: () => "search" } })).toMatchObject({ fromStore: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fetches again after the kind's keeping time", async () => {
    const f = okFetch();
    const { gate, clock } = setup(f);
    const req = searchFor("nothing here");
    await gate.call("mycardfolio", req, keep("search_empty"));
    await clock.advance(86_400_000 - 1);
    expect(await gate.call("mycardfolio", req, keep("search_empty"))).toMatchObject({ fromStore: true });
    await clock.advance(1);
    expect(await gate.call("mycardfolio", req, keep("search_empty"))).toMatchObject({ fromStore: false });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not keep an answer the caller says not to keep, or a failed one", async () => {
    const { gate, db } = setup(okFetch());
    await gate.call("mycardfolio", searchFor("a"), { cache: { kindOf: () => null } });
    expect(db.select().from(outsideCache).all()).toHaveLength(0);
    const failed = setup(vi.fn(async () => new Response("", { status: 404 })));
    await failed.gate.call("mycardfolio", searchFor("a"), keep());
    expect(failed.db.select().from(outsideCache).all()).toHaveLength(0);
  });

  it("prunes at once when the stored total passes the cap, the oldest first", async () => {
    const { gate, clock, db } = setup(okFetch("x".repeat(400)), createDb(":memory:"), new FakeClock(), { cacheCapBytes: 1000 });
    for (const q of ["a", "b", "c"]) {
      const p = gate.call("mycardfolio", searchFor(q), keep("card"));
      await clock.advance(2000);
      await p;
    }
    // The third write passed the cap and was pruned on that write, within the same hour.
    const left = db.select().from(outsideCache).all();
    expect(left.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(1000);
    const keyOf = (q: string) => requestKey({ method: "POST", host: "mycardfolio.com", path: "/api/mcp", json: searchFor(q).json, accept: SEARCH.accept }, ["query"]);
    expect(left.map((r) => r.key).sort()).toEqual([keyOf("b"), keyOf("c")].sort());
  });

  it("a full store prunes down to 90% of the cap, so it does not prune on every write", async () => {
    const { gate, clock, db } = setup(okFetch("x".repeat(100)), createDb(":memory:"), new FakeClock(), { cacheCapBytes: 1000 });
    const rows = () => db.select().from(outsideCache).all().length;
    const put = async (q: string) => {
      const p = gate.call("mycardfolio", searchFor(q), keep());
      await clock.advance(2000);
      await p;
      return rows();
    };
    for (let i = 0; i < 10; i++) await put(`q${i}`);
    // Exactly at the cap (10 x 100 bytes): nothing pruned yet.
    expect(rows()).toBe(10);
    // Past the cap: down to 900 bytes, then the next write fits again without a prune.
    const after: number[] = [];
    for (let i = 10; i < 14; i++) after.push(await put(`q${i}`));
    expect(after).toEqual([9, 10, 9, 10]);
  });

  it("the stored total is a running number in the gate, counted again from the table every hour", async () => {
    const { gate, clock, db } = setup(okFetch("x".repeat(100)), createDb(":memory:"), new FakeClock(), { cacheCapBytes: 1000 });
    const put = async (q: string) => {
      const p = gate.call("mycardfolio", searchFor(q), keep());
      await clock.advance(2000);
      await p;
    };
    await put("a");
    // Bytes that reach the table outside the gate: the running number does not see them.
    db.insert(outsideCache).values({ key: "big", source: "mycardfolio", kind: "card", body: "b", fetchedAt: new Date(clock.now() + 1), expiresAt: new Date(clock.now() + 86_400_000 * 30), bytes: 2000 }).run();
    await put("b");
    expect(db.select().from(outsideCache).all()).toHaveLength(3);
    // The hourly count sees them and prunes the oldest down to 900 bytes.
    await clock.advance(60 * 60 * 1000);
    await put("c");
    const left = db.select().from(outsideCache).all();
    expect(left.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(900);
    expect(left.map((r) => r.key)).not.toContain("big");
  });

  it("under the cap, prunes expired answers at most once an hour", async () => {
    const { gate, clock, db } = setup(okFetch("x"));
    const put = async (q: string) => {
      const p = gate.call("mycardfolio", searchFor(q), keep());
      await clock.advance(2000);
      await p;
    };
    await put("a");
    // An answer that is already out of date, as if kept from long ago.
    db.insert(outsideCache).values({ key: "old", source: "mycardfolio", kind: "search", body: "o", fetchedAt: new Date(0), expiresAt: new Date(clock.now() - 1), bytes: 1 }).run();
    await put("b");
    expect(db.select().from(outsideCache).all().map((r) => r.key)).toContain("old");
    await clock.advance(60 * 60 * 1000);
    await put("c");
    const keys = db.select().from(outsideCache).all().map((r) => r.key);
    expect(keys).not.toContain("old");
    expect(keys).toHaveLength(3);
  });
});

describe("answer limits", () => {
  it("refuses an answer larger than 2 MB", async () => {
    setLogSink(() => undefined);
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const { gate, db } = setup(vi.fn(async () => new Response(big, { status: 200 })));
    expect(await gate.call("mycardfolio", SEARCH, { cache: { kindOf: () => "search" } })).toMatchObject({ ok: false, reason: "too_large" });
    expect(db.select().from(outsideCache).all()).toHaveLength(0);
    const declared = setup(vi.fn(async () => new Response("small", { status: 200, headers: { "Content-Length": String(3 * 1024 * 1024) } })));
    expect(await declared.gate.call("mycardfolio", SEARCH)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("refuses a redirect and does not follow it", async () => {
    setLogSink(() => undefined);
    const f: FakeFetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    const { gate, clock } = setup(f);
    const p = gate.call("mycardfolio", SEARCH);
    await clock.advance(20_000);
    expect(await p).toMatchObject({ ok: false, reason: "redirect", status: 302 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("the owner's switch", () => {
  it("a switched off source makes no call and gives no stored answer", async () => {
    const f = okFetch();
    const { gate, db } = setup(f);
    await gate.call("mycardfolio", SEARCH, { cache: { kindOf: () => "search" } });
    setSourceEnabled(db, "mycardfolio", false);
    expect(await gate.call("mycardfolio", SEARCH, { cache: { kindOf: () => "search" } })).toMatchObject({ ok: false, reason: "off" });
    expect(await gate.call("mycardfolio", SEARCH, { line: "now" })).toMatchObject({ ok: false, reason: "off" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(db.select().from(outsideState).get()?.enabled).toBe(false);
  });
});

describe("logs", () => {
  it("carry only source, kind, status and errorKind: no URL, header, key or body", async () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const secret = "sk-test-SECRET-KEY-1234";
    const req: OutsideRequest = { ...SEARCH, query: { key: secret }, json: { secret } };
    const runs: [FakeFetch, string][] = [
      [vi.fn(async () => new Response(`body ${secret}`, { status: 429 })), "slow"],
      [vi.fn(async () => new Response(null, { status: 302, headers: { Location: `https://x/?k=${secret}` } })), "redirect"],
      [vi.fn(async () => { throw new Error(`failed ${secret}`); }), "fails"],
    ];
    for (const [f] of runs) {
      const { gate, clock } = setup(f);
      for (let i = 0; i < 3; i++) {
        const p = gate.call("mycardfolio", req);
        await clock.advance(20 * 60_000);
        await p;
      }
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const { time, level, event, ...rest } = JSON.parse(line);
      expect([time, level, event].every(Boolean)).toBe(true);
      expect(Object.keys(rest).sort()).toEqual(["errorKind", "kind", "source", "status"]);
    }
    const all = lines.join("\n");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("mycardfolio.com");
    expect(all).not.toContain("User-Agent");
  });
});

describe("one gate per database", () => {
  it("lives on globalThis next to the database, so a reloaded module keeps the same gate", async () => {
    const db = createDb(":memory:");
    const first = gateFor(db);
    expect(gateFor(db)).toBe(first);
    vi.resetModules();
    const reloaded = await import("./gate");
    expect(reloaded.gateFor).not.toBe(gateFor);
    expect(reloaded.gateFor(db)).toBe(first);
    expect((globalThis as unknown as { __crdGates?: WeakMap<Db, unknown> }).__crdGates?.get(db)).toBe(first);
    expect(gateFor(createDb(":memory:"))).not.toBe(first);
  });
});

/**
 * Lines that could reach an outside address without the gate: `fetch(`,
 * `.fetch(` (unless to the app's own "/..." address; "//host" and "/\\host"
 * are another host), any `fetchImpl(`, WebSocket, EventSource, and imports
 * of node:http, node:https, node:http2, node:net, node:tls, node:dgram or undici.
 */
function outsideFetchLines(text: string): number[] {
  const found: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;
    let bad = false;
    for (const m of line.matchAll(/\bfetch\(([^)]*)/g)) {
      if (!/^[`"']\/(?![/\\])/.test(m[1].trim())) bad = true;
    }
    if (/\bfetchImpl\(/.test(line)) bad = true;
    if (/\b(WebSocket|EventSource)\b/.test(line)) bad = true;
    if (/(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](node:)?(https?|http2|net|tls|dgram|undici)(\/[^"']*)?["']/.test(line)) bad = true;
    if (bad) found.push(i + 1);
  });
  return found;
}

describe("no other outside fetch in src", () => {
  it("the check flags every way out it knows", () => {
    const flagged = [
      'await fetch("https://x.example/")',
      "await fetch(url)",
      "await deps.fetch(url, init)",
      "await window.fetch(`https://x`)",
      "const r = await fetchImpl(url)",
      "await this.fetchImpl(\"/api/x\")",
      'import https from "node:https";',
      'import { request } from "node:http";',
      'import http from "http";',
      'import { fetch as f } from "undici";',
      'import { Agent } from "undici/types";',
      'const h = await import("node:https");',
      'const u = require("undici");',
      // A "//host" or "/\\host" address is another host, not the app's own.
      'await fetch("//evil.example/x")',
      "await deps.fetch(`//${host}/x`)",
      "await fetch('/\\\\evil.example')",
      'import net from "node:net";',
      'import { connect } from "node:tls";',
      'const s = require("net");',
      'const t = await import("tls");',
      'import http2 from "node:http2";',
      'const ws = new WebSocket("wss://x.example");',
      'const es = new EventSource("/api/events");',
      "const W = globalThis.WebSocket;",
    ];
    for (const line of flagged) expect(outsideFetchLines(line), line).toEqual([1]);
    const fine = [
      'await fetch("/api/scans")',
      "await deps.fetch(`/api/scans/${id}`)",
      'import fs from "node:fs";',
      'import { z } from "zod";',
      "// fetch(url) in a comment",
      "fetchImpl?: typeof fetch;",
      'import { netTotal } from "@/lib/money";',
      'import x from "./tls-notes";',
    ];
    for (const line of fine) expect(outsideFetchLines(line), line).toEqual([]);
  });

  it("only the gate calls fetch for an outside address", () => {
    const root = path.resolve(__dirname, "../..");
    const allowed = new Set([
      "lib/outside/gate.ts",
      // Alerts to the owner's Telegram and Discord.
      "lib/alerts.ts",
    ]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const n of outsideFetchLines(lines.join("\n"))) {
        // The browser store's pass-through of calls to the app's own server.
        if (rel === "components/items/scan-store.ts" && /\bfetch\(input, init\)/.test(lines[n - 1])) continue;
        // Only the address check from node:net (no socket): exactly this import, nothing more.
        if (rel === "lib/auth/rate-limit.ts" && lines[n - 1].trim() === 'import { isIP } from "node:net";') continue;
        offenders.push(`${rel}:${n}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(50);
  });
});
