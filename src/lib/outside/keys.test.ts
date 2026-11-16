import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { connectionKeys } from "@/db/schema";
import { env, resetEnvCache, settingsSecret } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { eq } from "drizzle-orm";
import { createGate, realClock } from "./gate";
import { KEY_MAX, keyStatus, openKey, openSealed, recordKeyTest, removeKey, saveKey, sealKey } from "./keys";
import { availableSources, isSourceId, SOURCES, sourceAvailable } from "./sources";

const KEY = "demo_Key-0123456789abcdefXYZ4f2a";
const SECRET_A = "settings-key-for-tests-only-0123456789";
const SECRET_B = "another-settings-key-for-tests-0123456789";

function row(db: Db) {
  return db.select().from(connectionKeys).where(eq(connectionKeys.source, "demo")).get()!;
}

afterEach(() => {
  delete process.env.SETTINGS_KEY;
  resetEnvCache();
  setLogSink();
});

describe("the vault", () => {
  it("save then open gives the key back inside the server, and the row holds no key", () => {
    const db = createDb(":memory:");
    expect(saveKey(db, "demo", `  ${KEY}  `, new Date(), SECRET_A)).toEqual({ ok: true });
    expect(openKey(db, "demo", SECRET_A)).toBe(KEY);
    const r = row(db);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.last4).toBe("4f2a");
    expect(Buffer.from(r.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(r.authTag, "base64")).toHaveLength(16);
  });

  it("a second save of the same key gives a different iv and ciphertext", () => {
    const a = sealKey("demo", KEY, SECRET_A);
    const b = sealKey("demo", KEY, SECRET_A);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    const db = createDb(":memory:");
    saveKey(db, "demo", KEY, new Date(), SECRET_A);
    const first = row(db);
    saveKey(db, "demo", KEY, new Date(), SECRET_A);
    const second = row(db);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("a changed bit in the ciphertext, iv or tag fails closed", () => {
    const sealed = sealKey("demo", KEY, SECRET_A);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] ^= 1;
      return buf.toString("base64");
    };
    expect(openSealed("demo", sealed, SECRET_A)).toBe(KEY);
    expect(openSealed("demo", { ...sealed, ciphertext: flip(sealed.ciphertext) }, SECRET_A)).toBeNull();
    expect(openSealed("demo", { ...sealed, iv: flip(sealed.iv) }, SECRET_A)).toBeNull();
    expect(openSealed("demo", { ...sealed, authTag: flip(sealed.authTag) }, SECRET_A)).toBeNull();
    expect(openSealed("demo", { ...sealed, authTag: "" }, SECRET_A)).toBeNull();
    expect(openSealed("demo", { ...sealed, iv: "not base64 at all!" }, SECRET_A)).toBeNull();
  });

  it("a key saved for one source cannot be opened as another (source id is bound in)", () => {
    const sealed = sealKey("demo", KEY, SECRET_A);
    expect(openSealed("mycardfolio", sealed, SECRET_A)).toBeNull();
  });

  it("a changed setting gives \"enter again\", never a crash", () => {
    const db = createDb(":memory:");
    saveKey(db, "demo", KEY, new Date(), SECRET_A);
    expect(openKey(db, "demo", SECRET_B)).toBeNull();
    expect(keyStatus(db, "demo", SECRET_B)).toMatchObject({ state: "enter_again" });
    expect(keyStatus(db, "demo", SECRET_A)).toMatchObject({ state: "saved", last4: "4f2a", lastTestOk: null });
  });

  it("refuses keys shorter than 16 or longer than 200 characters, or of the wrong shape", () => {
    const db = createDb(":memory:");
    expect(saveKey(db, "demo", "short-key-123", new Date(), SECRET_A)).toEqual({ ok: false, message: "A key has at least 16 characters." });
    expect(saveKey(db, "demo", "               abc               ", new Date(), SECRET_A).ok).toBe(false);
    expect(saveKey(db, "demo", "a".repeat(KEY_MAX + 1), new Date(), SECRET_A)).toEqual({ ok: false, message: "A key has at most 200 characters." });
    expect(saveKey(db, "demo", "a".repeat(KEY_MAX), new Date(), SECRET_A).ok).toBe(true);
    const bad = saveKey(db, "demo", "has spaces inside the key!", new Date(), SECRET_A);
    expect(bad).toEqual({ ok: false, message: SOURCES.demo.key!.hint });
    expect(saveKey(db, "demo", 12345, new Date(), SECRET_A).ok).toBe(false);
    expect(saveKey(db, "mycardfolio", KEY, new Date(), SECRET_A)).toEqual({ ok: false, message: "This connection does not use a key." });
  });

  it("an error message never repeats what was typed", () => {
    const db = createDb(":memory:");
    for (const raw of ["x".repeat(201), "bad key with spaces 0123456789", "tiny"]) {
      const r = saveKey(db, "demo", raw, new Date(), SECRET_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain(raw.slice(0, 10));
    }
  });

  it("remove deletes the row; the last test stores only ok or failed and the time", () => {
    const db = createDb(":memory:");
    saveKey(db, "demo", KEY, new Date(), SECRET_A);
    const at = new Date("2026-11-16T10:00:00Z");
    recordKeyTest(db, "demo", false, at);
    expect(row(db)).toMatchObject({ lastTestResult: "failed", lastTestAt: at });
    expect(keyStatus(db, "demo", SECRET_A)).toMatchObject({ state: "saved", lastTestOk: false });
    expect(removeKey(db, "demo")).toBe(true);
    expect(removeKey(db, "demo")).toBe(false);
    expect(keyStatus(db, "demo", SECRET_A)).toEqual({ state: "none" });
  });
});

describe("SETTINGS_KEY", () => {
  it("is used when set, and SESSION_SECRET when it is not", () => {
    expect(settingsSecret({ SETTINGS_KEY: SECRET_A, SESSION_SECRET: "s".repeat(32) })).toBe(SECRET_A);
    expect(settingsSecret({ SETTINGS_KEY: undefined, SESSION_SECRET: "s".repeat(32) })).toBe("s".repeat(32));
    resetEnvCache();
    expect(settingsSecret()).toBe(env().SESSION_SECRET);
    process.env.SETTINGS_KEY = "";
    resetEnvCache();
    expect(env().SETTINGS_KEY).toBeUndefined();
    process.env.SETTINGS_KEY = SECRET_A;
    resetEnvCache();
    expect(settingsSecret()).toBe(SECRET_A);
  });

  it("must be at least 32 characters, and the error does not show it", () => {
    process.env.SETTINGS_KEY = "too-short-setting";
    resetEnvCache();
    expect(() => env()).toThrow(/SETTINGS_KEY must be at least 32 characters/);
    try { env(); } catch (e) { expect(String(e)).not.toContain("too-short-setting"); }
  });

  it("a key saved under SESSION_SECRET must be entered again once SETTINGS_KEY is set", () => {
    const db = createDb(":memory:");
    expect(saveKey(db, "demo", KEY).ok).toBe(true);
    expect(openKey(db, "demo")).toBe(KEY);
    process.env.SETTINGS_KEY = SECRET_A;
    resetEnvCache();
    expect(openKey(db, "demo")).toBeNull();
    expect(keyStatus(db, "demo").state).toBe("enter_again");
  });
});

describe("the demo source", () => {
  it("exists only outside production", () => {
    expect(sourceAvailable("demo", "development")).toBe(true);
    expect(sourceAvailable("demo", "production")).toBe(false);
    expect(availableSources("production")).toEqual(["mycardfolio", "wikidata"]);
    expect(availableSources("test")).toEqual(["mycardfolio", "wikidata", "demo"]);
    expect(isSourceId("demo")).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(isSourceId("demo")).toBe(false);
      expect(isSourceId("mycardfolio")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is refused by the gate in production, without a call", async () => {
    const db = createDb(":memory:");
    saveKey(db, "demo", KEY);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubEnv("NODE_ENV", "production");
    try {
      const gate = createGate({ db, clock: realClock, fetch: fetchImpl as unknown as typeof fetch });
      expect(await gate.call("demo", SOURCES.demo.testCall, { line: "now" })).toMatchObject({ ok: false, reason: "off" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the gate and keys", () => {
  it("without a key, or with one that cannot be opened, makes no call", async () => {
    const db = createDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const gate = createGate({ db, clock: realClock, fetch: fetchImpl as unknown as typeof fetch });
    expect(await gate.call("demo", SOURCES.demo.testCall, { line: "now" })).toMatchObject({ ok: false, reason: "needs_key" });
    saveKey(db, "demo", KEY, new Date(), SECRET_B);
    expect(await gate.call("demo", SOURCES.demo.testCall, { line: "now" })).toMatchObject({ ok: false, reason: "needs_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adds the key as the source's header at the last step and logs nothing of it", async () => {
    const db = createDb(":memory:");
    saveKey(db, "demo", KEY);
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return new Response("nope", { status: 500 });
    });
    const gate = createGate({ db, clock: realClock, fetch: fetchImpl as unknown as typeof fetch });
    const r = await gate.call("demo", SOURCES.demo.testCall, { line: "now" });
    expect(r).toMatchObject({ ok: false, reason: "server" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://demo.invalid/ping");
    expect((init!.headers as Record<string, string>)["X-Demo-Key"]).toBe(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("4f2a");
  });
});
