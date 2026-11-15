import { afterEach, describe, expect, it } from "vitest";
import { appOriginHost, env, resetEnvCache } from "./env";

const saved = { ...process.env };
function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

afterEach(() => {
  for (const k of ["APP_ORIGIN", "TRUST_PROXY_HOPS", "NODE_ENV", "OWNER_PASSWORD_HASH_B64", "SETUP_CODE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("APP_ORIGIN", () => {
  it("is optional, and empty means unset", () => {
    withEnv({ APP_ORIGIN: "" });
    expect(env().APP_ORIGIN).toBeUndefined();
    expect(appOriginHost()).toBeNull();
  });
  it("accepts a bare address and gives its host", () => {
    withEnv({ APP_ORIGIN: "https://Cards.Example.com" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    withEnv({ APP_ORIGIN: "https://cards.example.com" });
    expect(appOriginHost()).toBe("cards.example.com");
    withEnv({ APP_ORIGIN: "http://localhost:3000" });
    expect(appOriginHost()).toBe("localhost:3000");
  });
  it("tidies a trailing slash or path, and rejects another protocol or a bare name", () => {
    withEnv({ APP_ORIGIN: "https://cards.example.com/app/" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    for (const bad of ["ftp://cards.example.com", "cards.example.com"]) {
      withEnv({ APP_ORIGIN: bad });
      expect(() => env(), bad).toThrow(/APP_ORIGIN/);
    }
  });
  it("must be https in production", () => {
    withEnv({ NODE_ENV: "production", APP_ORIGIN: "http://cards.example.com" });
    expect(() => env()).toThrow(/https/);
    withEnv({ NODE_ENV: "production", APP_ORIGIN: "https://cards.example.com" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
  });
  it("allows http in production only for this computer", () => {
    for (const ok of ["http://localhost:3300", "http://127.0.0.1:3300", "http://[::1]:3300"]) {
      withEnv({ NODE_ENV: "production", APP_ORIGIN: ok });
      expect(env().APP_ORIGIN, ok).toBe(ok);
    }
    for (const bad of ["http://localhost.example.com", "http://127.0.0.2", "http://10.0.0.1:3000"]) {
      withEnv({ NODE_ENV: "production", APP_ORIGIN: bad });
      expect(() => env(), bad).toThrow(/https/);
    }
  });
});

describe("password settings", () => {
  it("OWNER_PASSWORD_HASH_B64 is optional, and empty means unset", () => {
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined });
    expect(env().OWNER_PASSWORD_HASH_B64).toBeUndefined();
    withEnv({ OWNER_PASSWORD_HASH_B64: "" });
    expect(env().OWNER_PASSWORD_HASH_B64).toBeUndefined();
  });
  it("SETUP_CODE is optional but at least 16 characters", () => {
    withEnv({ SETUP_CODE: "" });
    expect(env().SETUP_CODE).toBeUndefined();
    withEnv({ SETUP_CODE: "short-code" });
    expect(() => env()).toThrow(/SETUP_CODE/);
    withEnv({ SETUP_CODE: "a".repeat(16) });
    expect(env().SETUP_CODE).toBe("a".repeat(16));
  });
});

describe("TRUST_PROXY_HOPS", () => {
  it("defaults to 0", () => {
    withEnv({ TRUST_PROXY_HOPS: undefined });
    expect(env().TRUST_PROXY_HOPS).toBe(0);
    withEnv({ TRUST_PROXY_HOPS: "" });
    expect(env().TRUST_PROXY_HOPS).toBe(0);
  });
  it("accepts 0 to 5 only", () => {
    withEnv({ TRUST_PROXY_HOPS: "2" });
    expect(env().TRUST_PROXY_HOPS).toBe(2);
    for (const bad of ["6", "-1", "1.5", "two"]) {
      withEnv({ TRUST_PROXY_HOPS: bad });
      expect(() => env(), bad).toThrow(/TRUST_PROXY_HOPS/);
    }
  });
});

describe("APP_ORIGIN from a hosting panel", () => {
  it("keeps only the origin when a trailing slash or path is included", async () => {
    const { env, resetEnvCache } = await import("./env");
    const before = process.env.APP_ORIGIN;
    for (const [given, expected] of [["https://cards.example.com/", "https://cards.example.com"], ["https://cards.example.com/x/y", "https://cards.example.com"], [" https://cards.example.com ", "https://cards.example.com"]]) {
      process.env.APP_ORIGIN = given;
      resetEnvCache();
      expect(env().APP_ORIGIN).toBe(expected);
    }
    process.env.APP_ORIGIN = before;
    if (before === undefined) delete process.env.APP_ORIGIN;
    resetEnvCache();
  });
});

