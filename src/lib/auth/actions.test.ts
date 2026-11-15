import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { DEVICE_COOKIE, readDevice, SESSION_COOKIE } from "./seal";
import { MAX_FAILS_GLOBAL, resetPruneCounter } from "./rate-limit";

// A tiny stand-in for the request: one cookie jar and the request headers.
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

const { login, logout, signOutOtherDevices } = await import("./actions");
const { isOwner } = await import("./guard");

const SECRET = "test-only-session-secret-0123456789abcdef";
let db: Db;

function form(password: string): FormData {
  const f = new FormData();
  f.set("password", password);
  return f;
}
async function signInWith(password: string) {
  try {
    return await login({ error: null }, form(password));
  } catch (e) {
    if (e instanceof Redirected) return { redirected: e.to };
    throw e;
  }
}

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetPruneCounter();
  jar.clear();
  requestHeaders = new Headers();
  resetEnvCache();
});
afterEach(() => {
  setDbForTests(undefined);
  delete process.env.TRUST_PROXY_HOPS;
  resetEnvCache();
});

describe("sign-in with a trusted device", () => {
  it("issues a trusted-device cookie and clears earlier failures", async () => {
    process.env.TRUST_PROXY_HOPS = "1";
    resetEnvCache();
    requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
    expect(await signInWith("wrong")).toEqual({ error: "Wrong password. Try again." });
    expect(await signInWith("test-password")).toEqual({ redirected: "/" });
    expect(jar.has(SESSION_COOKIE)).toBe(true);
    expect(await readDevice(jar.get(DEVICE_COOKIE), SECRET, 0)).toMatch(/^[0-9a-f]{32}$/);
    expect(db.select().from(loginAttempts).all().filter((r) => !r.success)).toHaveLength(0);
  });

  it("strangers cannot lock out a browser that signed in before", async () => {
    // Every visitor is "unknown" (TRUST_PROXY_HOPS=0), the risky default.
    expect(await signInWith("test-password")).toEqual({ redirected: "/" });
    const device = jar.get(DEVICE_COOKIE)!;
    try {
      await logout();
    } catch (e) {
      if (!(e instanceof Redirected)) throw e;
    }
    // Strangers (no device cookie) use up the shared address and pause everyone.
    jar.clear();
    for (let i = 0; i < 5; i++) await signInWith("guess");
    for (let i = 0; i < MAX_FAILS_GLOBAL / 5; i++) {
      for (let j = 0; j < 5; j++) db.insert(loginAttempts).values({ ip: `10.2.${i}.1`, net: `10.2.${i}.1`, success: false }).run();
    }
    expect(await signInWith("test-password")).toMatchObject({ error: expect.stringMatching(/Too many tries/) });
    // The owner's phone still gets in, even after a typo.
    jar.set(DEVICE_COOKIE, device);
    expect(await signInWith("typo")).toEqual({ error: "Wrong password. Try again." });
    expect(await signInWith("test-password")).toEqual({ redirected: "/" });
    expect(await isOwner()).toBe(true);
  });

  it("a trusted device has its own limit of 10 failures", async () => {
    await signInWith("test-password");
    for (let i = 0; i < 10; i++) expect(await signInWith("typo")).toEqual({ error: "Wrong password. Try again." });
    expect(await signInWith("test-password")).toMatchObject({ error: expect.stringMatching(/Too many tries/) });
  });
});

describe("sign out all other devices with the password in the server settings", () => {
  it("signs out other browsers and revokes their trusted-device cookies, keeping this one", async () => {
    await signInWith("test-password");
    const otherSession = jar.get(SESSION_COOKIE)!;
    const otherDevice = jar.get(DEVICE_COOKIE)!;
    jar.clear();
    await signInWith("test-password");
    expect(await signOutOtherDevices()).toEqual({ error: null, done: true });
    expect(await isOwner()).toBe(true);
    expect(await readDevice(jar.get(DEVICE_COOKIE), SECRET, 1)).not.toBeNull();
    // The other browser is signed out and no longer trusted.
    jar.set(SESSION_COOKIE, otherSession);
    expect(await isOwner()).toBe(false);
    expect(await readDevice(otherDevice, SECRET, 1)).toBeNull();
  });
});
