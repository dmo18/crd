import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, loginAttempts } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { MAX_FAILS_GLOBAL, resetPruneCounter } from "@/lib/auth/rate-limit";
import { createOwnerPassword } from "@/lib/auth/password";
import { DEVICE_COOKIE } from "@/lib/auth/seal";

// Same stand-ins as src/lib/auth/actions.test.ts: one cookie jar and the request headers.
const jar = new Map<string, string>();
let requestHeaders = new Headers();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => { if (value === "") jar.delete(name); else jar.set(name, value); },
  delete: (name: string) => { jar.delete(name); },
  has: (name: string) => jar.has(name),
};
vi.mock("next/headers", () => ({ cookies: async () => cookieStore, headers: async () => requestHeaders }));
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect ${to}`); }
}
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirected(to); } }));
// Alerts are only queued here; their sending is tested in alerts.test.ts.
const queued: { key: string; title: string }[] = [];
vi.mock("@/lib/alerts", async (original) => ({
  ...(await original<typeof import("@/lib/alerts")>()),
  queueAlert: (key: string, _cooldown: number, alert: { title: string }) => { queued.push({ key, title: alert.title }); },
}));

const { login, logout, changePassword } = await import("@/lib/auth/actions");
const { resetAuditPrune } = await import("./store");

let db: Db;
const savedHash = process.env.OWNER_PASSWORD_HASH_B64;

async function run<T>(fn: () => Promise<T>): Promise<T | { redirected: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Redirected) return { redirected: e.to };
    throw e;
  }
}
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const signIn = (password: string) => run(() => login({ error: null }, form({ password })));
const events = () => db.select().from(auditEvents).all();

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetPruneCounter();
  resetAuditPrune();
  jar.clear();
  queued.length = 0;
  process.env.TRUST_PROXY_HOPS = "1";
  resetEnvCache();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7", "x-request-id": "req-1" });
  setLogSink(() => undefined);
});
afterEach(() => {
  setDbForTests(undefined);
  delete process.env.TRUST_PROXY_HOPS;
  process.env.OWNER_PASSWORD_HASH_B64 = savedHash;
  resetEnvCache();
  setLogSink();
});

describe("activity log for sign-in", () => {
  it("records a wrong password with the visitor's address and nothing secret", async () => {
    expect(await signIn("my-wrong-guess")).toEqual({ error: "Wrong password. Try again." });
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "sign_in_failed", outcome: "failed", ip: "203.0.113.7", deviceId: null });
    expect(JSON.stringify(rows)).not.toContain("my-wrong-guess");
  });

  it("records a sign-in from a new device, alerts once, and knows the device next time", async () => {
    expect(await signIn("test-password")).toEqual({ redirected: "/" });
    let rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "sign_in_ok", outcome: "ok", ip: "203.0.113.7", detail: "new device" });
    expect(rows[0]!.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain("test-password");
    expect(queued).toEqual([{ key: "new_device", title: "Signed in on a new device" }]);

    // Same browser again: a known device, no alert.
    await run(() => logout());
    expect(events().at(-1)).toMatchObject({ event: "signed_out", outcome: "ok" });
    expect(jar.has(DEVICE_COOKIE)).toBe(true);
    expect(await signIn("test-password")).toEqual({ redirected: "/" });
    rows = events();
    expect(rows.at(-1)).toMatchObject({ event: "sign_in_ok", detail: null, deviceId: rows[0]!.deviceId });
    expect(queued).toHaveLength(1);
  });

  it("alerts when 5 sign-ins fail within 15 minutes, from any address", async () => {
    for (let i = 1; i <= 4; i++) {
      requestHeaders = new Headers({ "x-forwarded-for": `198.51.100.${i}` });
      await signIn("guess");
    }
    expect(queued).toHaveLength(0);
    requestHeaders = new Headers({ "x-forwarded-for": "198.51.100.5" });
    await signIn("guess");
    expect(queued).toEqual([{ key: "many_failed_sign_ins", title: "Many wrong passwords" }]);
  });

  it("records a blocked attempt once per address and alerts when everyone is paused", async () => {
    for (let i = 0; i < MAX_FAILS_GLOBAL / 5; i++) {
      for (let j = 0; j < 5; j++) db.insert(loginAttempts).values({ ip: `10.2.${i}.1`, net: `10.2.${i}.1`, success: false }).run();
    }
    expect(await signIn("test-password")).toMatchObject({ error: expect.stringMatching(/Too many tries/) });
    expect(await signIn("test-password")).toMatchObject({ error: expect.stringMatching(/Too many tries/) });
    const blocked = events().filter((r) => r.event === "sign_in_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ outcome: "blocked", detail: "everyone", ip: "203.0.113.7" });
    expect(queued.map((q) => q.key)).toEqual(["sign_in_paused", "sign_in_paused"]);
  });
});

describe("activity log for a password change", () => {
  it("records the change and queues an alert, without the passwords", async () => {
    delete process.env.OWNER_PASSWORD_HASH_B64;
    resetEnvCache();
    createOwnerPassword(bcrypt.hashSync("old-password-0123456789", 4), db);
    expect(await signIn("old-password-0123456789")).toEqual({ redirected: "/" });
    queued.length = 0;
    const result = await changePassword({ error: null, done: false }, form({
      current: "old-password-0123456789", password: "brand-new-password-9876", confirm: "brand-new-password-9876",
    }));
    expect(result).toEqual({ error: null, done: true });
    const row = events().at(-1)!;
    expect(row).toMatchObject({ event: "password_changed", outcome: "ok", ip: "203.0.113.7" });
    expect(JSON.stringify(events())).not.toMatch(/old-password|brand-new-password/);
    expect(queued).toEqual([{ key: "password_changed", title: "Password changed" }]);
  });
});
