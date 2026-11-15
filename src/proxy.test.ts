import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, loginUrl } from "./proxy";

const internal = (headers: Record<string, string> = {}) => ({
  url: "http://127.0.0.1:3210/cards?x=1",
  headers: new Headers({ host: "127.0.0.1:3210", ...headers }),
});

describe("loginUrl", () => {
  it("uses APP_ORIGIN when set, whatever the headers say", () => {
    const req = internal({ "x-forwarded-host": "evil.com", "x-forwarded-proto": "http" });
    expect(loginUrl(req, { appOrigin: "https://cards.example.com", nodeEnv: "production" }).href)
      .toBe("https://cards.example.com/login");
  });
  it("in development without APP_ORIGIN, uses valid forwarded host and protocol", () => {
    const req = internal({ "x-forwarded-host": "cards.test:8443, other", "x-forwarded-proto": "https" });
    expect(loginUrl(req, { nodeEnv: "development" }).href).toBe("https://cards.test:8443/login");
  });
  it("in development ignores forwarded headers that do not look valid", () => {
    expect(loginUrl(internal({ "x-forwarded-host": "a.com/evil", "x-forwarded-proto": "https" }), { nodeEnv: "development" }).href)
      .toBe("http://127.0.0.1:3210/login");
    expect(loginUrl(internal({ "x-forwarded-host": "a.com", "x-forwarded-proto": "javascript" }), { nodeEnv: "development" }).href)
      .toBe("http://127.0.0.1:3210/login");
  });
  it("in production without APP_ORIGIN never trusts forwarded headers", () => {
    const req = internal({ "x-forwarded-host": "evil.com", "x-forwarded-proto": "https" });
    expect(loginUrl(req, { nodeEnv: "production" }).href).toBe("http://127.0.0.1:3210/login");
  });
});

describe("proxy matcher", () => {
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
  it("runs on pages and API routes", () => {
    expect(runs("/")).toBe(true);
    expect(runs("/cards/12")).toBe(true);
    expect(runs("/api/scans")).toBe(true);
  });
  it("skips the sign-in page, the health check and static files", () => {
    expect(runs("/login")).toBe(false);
    expect(runs("/api/health")).toBe(false);
    expect(runs("/_next/static/chunk.js")).toBe(false);
    expect(runs("/favicon.ico")).toBe(false);
  });
});
