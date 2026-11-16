import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { alertState, auditEvents, connectionKeys, outsideCache } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { resetAuditPrune } from "@/lib/audit/store";

// The owner session: a switch per test. The real session check is tested in src/lib/auth.
let owner = true;
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect ${to}`); }
}
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Redirected("/login"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The real gate with a fake fetch: no test reaches the network.
const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
  void init;
  return new Response('{"ok":true}', { status: 200 });
});
vi.mock("./gate", async (original) => {
  const real = await original<typeof import("./gate")>();
  const gates = new WeakMap<Db, InstanceType<typeof real.Gate>>();
  const gateFor = (db: Db) => {
    let g = gates.get(db);
    if (!g) { g = real.createGate({ db, fetch: fakeFetch as unknown as typeof fetch, random: () => 0 }); gates.set(db, g); }
    return g;
  };
  return {
    ...real,
    gateFor,
    outsideCall: (source: Parameters<typeof real.outsideCall>[0], req: Parameters<typeof real.outsideCall>[1], opts: Parameters<typeof real.outsideCall>[2] = {}) =>
      gateFor(opts.db!).call(source, req, opts),
  };
});

const actions = await import("./actions");
const { default: ConnectionsPage } = await import("@/app/(app)/more/connections/page");
const { putCached } = await import("./cache");
const { pauseSource } = await import("./usage");

const KEY = "demo_Key-0123456789abcdefXYZ4f2a";
const LAST4 = "4f2a";
const empty = { ok: null, message: null };
let db: Db;
let logLines: string[];

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const audit = () => db.select().from(auditEvents).all();
/** Lets the next Test run at once (Test is limited to one per 10 seconds per source). */
const allowTest = () => db.delete(alertState).run();
async function page(): Promise<string> {
  return renderToString(await ConnectionsPage());
}

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  resetEnvCache();
  owner = true;
  fakeFetch.mockClear();
  fakeFetch.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }));
  logLines = [];
  setLogSink((l) => logLines.push(l));
});
afterEach(() => {
  setDbForTests(undefined);
  setLogSink();
});

describe("owner required", () => {
  it("every action refuses without the owner session and changes nothing", async () => {
    owner = false;
    const f = form({ source: "demo", key: KEY, on: "0" });
    for (const act of [actions.saveKeyAction, actions.removeKeyAction, actions.testConnectionAction, actions.switchSourceAction, actions.clearAnswersAction]) {
      expect(await act(empty, f)).toEqual({ ok: false, message: "Please sign in again." });
    }
    expect(db.select().from(connectionKeys).all()).toHaveLength(0);
    expect(audit()).toHaveLength(0);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("the page sends a visitor without the session to sign in", async () => {
    owner = false;
    await expect(ConnectionsPage()).rejects.toThrow("redirect /login");
  });
});

describe("form checks (zod)", () => {
  it("refuses an unknown source, a missing field, a bad switch value or a key for a source without keys", async () => {
    const bad = { ok: false, message: "That did not work. Reload the page and try again." };
    expect(await actions.saveKeyAction(empty, form({ source: "nope", key: KEY }))).toEqual(bad);
    expect(await actions.saveKeyAction(empty, form({ source: "demo" }))).toEqual(bad);
    expect(await actions.saveKeyAction(empty, form({ source: "demo", key: "x".repeat(1001) }))).toEqual(bad);
    expect(await actions.saveKeyAction(empty, form({ source: "mycardfolio", key: KEY }))).toEqual(bad);
    expect(await actions.switchSourceAction(empty, form({ source: "wikidata", on: "maybe" }))).toEqual(bad);
    expect(await actions.testConnectionAction(empty, form({ source: "../etc" }))).toEqual(bad);
    expect(await actions.clearAnswersAction(empty, "not a form" as unknown as FormData)).toEqual(bad);
    expect(db.select().from(connectionKeys).all()).toHaveLength(0);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("the demo source is refused in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await actions.saveKeyAction(empty, form({ source: "demo", key: KEY }))).ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(db.select().from(connectionKeys).all()).toHaveLength(0);
  });
});

describe("the key flow, and the key appears nowhere", () => {
  it("save, page, test, failed test, short key, replace, remove: no key or last 4 in answers, audit or logs; the page shows only the last 4", async () => {
    const answers: unknown[] = [];
    const before = await page();
    expect(before).toContain("Key for Demo source");
    expect(before).toMatch(/type="password"/);
    expect(before).toMatch(/autoComplete="off"|autocomplete="off"/);

    answers.push(await actions.saveKeyAction(empty, form({ source: "demo", key: KEY })));
    expect(answers.at(-1)).toEqual({ ok: true, message: "Key saved. Tap Test to check it." });

    const after = await page();
    expect(after).not.toContain(KEY);
    expect(after).toContain(`ends in ...${LAST4}`);
    expect(after).not.toContain(KEY.slice(0, -4));

    answers.push(await actions.testConnectionAction(empty, form({ source: "demo" })));
    expect(answers.at(-1)).toMatchObject({ ok: true });
    expect((fakeFetch.mock.calls[0][1]!.headers as Record<string, string>)["X-Demo-Key"]).toBe(KEY);
    expect(db.select().from(connectionKeys).get()).toMatchObject({ lastTestResult: "ok" });

    answers.push(await actions.testConnectionAction(empty, form({ source: "demo" })));
    expect(answers.at(-1)).toEqual({ ok: false, message: "A test just ran. Wait a few seconds and try again." });

    allowTest();
    fakeFetch.mockImplementation(async () => new Response("denied", { status: 401 }));
    answers.push(await actions.testConnectionAction(empty, form({ source: "demo" })));
    expect(answers.at(-1)).toEqual({ ok: false, message: "The site refused the request." });
    expect(db.select().from(connectionKeys).get()).toMatchObject({ lastTestResult: "failed" });

    answers.push(await actions.saveKeyAction(empty, form({ source: "demo", key: "short" })));
    expect(answers.at(-1)).toEqual({ ok: false, message: "A key has at least 16 characters." });
    expect(db.select().from(connectionKeys).get()!.last4).toBe(LAST4);

    const other = "demo_Other-key-0123456789abcd9z9z";
    answers.push(await actions.saveKeyAction(empty, form({ source: "demo", key: other })));
    expect(db.select().from(connectionKeys).get()!.last4).toBe("9z9z");
    expect(db.select().from(connectionKeys).get()!.lastTestResult).toBeNull();

    answers.push(await actions.removeKeyAction(empty, form({ source: "demo" })));
    expect(answers.at(-1)).toEqual({ ok: true, message: "Key removed." });
    expect(db.select().from(connectionKeys).all()).toHaveLength(0);

    allowTest();
    answers.push(await actions.testConnectionAction(empty, form({ source: "demo" })));
    expect(answers.at(-1)).toEqual({ ok: false, message: "Save a key first, or enter it again." });

    const events = audit();
    expect(events.map((e) => [e.event, e.outcome])).toEqual([
      ["connection_key_saved", "ok"],
      ["connection_tested", "ok"],
      ["connection_tested", "failed"],
      ["connection_key_saved", "failed"],
      ["connection_key_saved", "ok"],
      ["connection_key_removed", "ok"],
      ["connection_tested", "failed"],
    ]);
    const everything = JSON.stringify([answers, events, logLines, await page()]);
    for (const secret of [KEY, other, KEY.slice(0, 12)]) expect(everything).not.toContain(secret);
    const auditAndLogs = JSON.stringify([answers, events, logLines]);
    expect(auditAndLogs).not.toContain(LAST4);
    expect(auditAndLogs).not.toContain("9z9z");
    for (const e of events) expect(e.detail).toMatch(/^Demo source/);
  });

  it("a key that cannot be opened shows \"enter again\" and Test makes no call", async () => {
    await actions.saveKeyAction(empty, form({ source: "demo", key: KEY }));
    process.env.SETTINGS_KEY = "a-new-settings-key-0123456789-abcdef";
    resetEnvCache();
    try {
      const html = await page();
      expect(html).toContain("This key must be entered again");
      expect(html).not.toContain(LAST4);
      expect(await actions.testConnectionAction(empty, form({ source: "demo" }))).toEqual({ ok: false, message: "Save a key first, or enter it again." });
      expect(fakeFetch).not.toHaveBeenCalled();
    } finally {
      delete process.env.SETTINGS_KEY;
      resetEnvCache();
    }
  });
});

describe("Test, switch and clear", () => {
  it("Test makes one call through the gate in the now line and says how long it took", async () => {
    const r = await actions.testConnectionAction(empty, form({ source: "mycardfolio" }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Works, answered in \d+\.\d s\.$/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(String(fakeFetch.mock.calls[0][0])).toBe("https://mycardfolio.com/api/mcp");
    expect(audit()[0]).toMatchObject({ event: "connection_tested", outcome: "ok", detail: "MyCardfolio: works" });
  });

  it("Test is limited to one per 10 seconds per source", async () => {
    expect((await actions.testConnectionAction(empty, form({ source: "wikidata" }))).ok).toBe(true);
    expect((await actions.testConnectionAction(empty, form({ source: "wikidata" }))).ok).toBe(false);
    expect((await actions.testConnectionAction(empty, form({ source: "mycardfolio" }))).ok).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    db.update(alertState).set({ lastSentAt: new Date(Date.now() - 10_001) }).run();
    expect((await actions.testConnectionAction(empty, form({ source: "wikidata" }))).ok).toBe(true);
  });

  it("switching off stops all calls, and is recorded", async () => {
    expect(await actions.switchSourceAction(empty, form({ source: "mycardfolio", on: "0" }))).toMatchObject({ ok: true });
    expect(await actions.testConnectionAction(empty, form({ source: "mycardfolio" }))).toEqual({ ok: false, message: "This source is switched off." });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(await page()).toContain("Switched off. The app makes no calls to MyCardfolio.");
    await actions.switchSourceAction(empty, form({ source: "mycardfolio", on: "1" }));
    expect(audit().filter((e) => e.event === "connection_switched").map((e) => e.detail)).toEqual(["MyCardfolio off", "MyCardfolio on"]);
  });

  it("clears the stored answers of one source only", async () => {
    const now = Date.now();
    putCached(db, { key: "a", source: "mycardfolio", kind: "search", body: "{}", nowMs: now });
    putCached(db, { key: "b", source: "mycardfolio", kind: "card", body: "{}", nowMs: now });
    putCached(db, { key: "c", source: "wikidata", kind: "search", body: "{}", nowMs: now });
    expect(await actions.clearAnswersAction(empty, form({ source: "mycardfolio" }))).toEqual({ ok: true, message: "Cleared 2 stored answers." });
    expect(db.select().from(outsideCache).all().map((r) => r.key)).toEqual(["c"]);
    expect(audit()[0]).toMatchObject({ event: "catalog_answers_cleared", detail: "MyCardfolio, 2 stored answers" });
    expect(await actions.clearAnswersAction(empty, form({ source: "mycardfolio" }))).toEqual({ ok: true, message: "Nothing was stored." });
  });
});

describe("the page", () => {
  it("shows MyCardfolio, Wikidata and the demo source with state, switch, Test, clear and usage", async () => {
    pauseSource(db, "wikidata", Date.now() + 60_000, "The site asked us to slow down", Date.now());
    const html = await page();
    for (const text of ["MyCardfolio", "Wikidata", "Demo source", "Paused until", "the site asked us to slow down",
      "Needs a key", "Switch off", "Clear stored answers", "Calls today", "0 of 1,000", "Calls this hour", "0 of 200",
      "Taken from stored answers today", "Errors today", "Last good call", "Calls per day, last 7 days"]) {
      expect(html).toContain(text);
    }
    expect((html.match(/>Test</g) ?? []).length).toBe(3);
  });
});
