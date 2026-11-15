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
  for (const k of ["APP_ORIGIN", "TRUST_PROXY_HOPS", "NODE_ENV"]) {
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
    expect(() => env()).toThrow(/no slash/);
    withEnv({ APP_ORIGIN: "https://cards.example.com" });
    expect(appOriginHost()).toBe("cards.example.com");
    withEnv({ APP_ORIGIN: "http://localhost:3000" });
    expect(appOriginHost()).toBe("localhost:3000");
  });
  it("rejects a trailing slash, a path, or another protocol", () => {
    for (const bad of ["https://cards.example.com/", "https://cards.example.com/app", "ftp://cards.example.com", "cards.example.com"]) {
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
