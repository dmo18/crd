import { sealData } from "iron-session";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { sealDevice } from "@/lib/auth/seal";
import { config, contentSecurityPolicy, isPublicPath, loginUrl, proxy } from "./proxy";

const SECRET = "test-only-session-secret-0123456789abcdef";

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
  it("runs on pages, API routes, and the public pages (for the CSP header)", () => {
    for (const url of ["/", "/cards/12", "/api/scans", "/more", "/login", "/setup", "/api/health"]) expect(runs(url)).toBe(true);
  });
  it("skips static files", () => {
    expect(runs("/_next/static/chunk.js")).toBe(false);
    expect(runs("/favicon.ico")).toBe(false);
    expect(runs("/icons/icon-192.png")).toBe(false);
  });
  it("lets only sign-in, setup and the health check through without a session", () => {
    expect(["/login", "/setup", "/api/health", "/login/"].every(isPublicPath)).toBe(true);
    expect(["/", "/loginx", "/api/scans", "/api/healthz", "/more"].some(isPublicPath)).toBe(false);
  });
});

describe("proxy session check", () => {
  const req = (path: string, cookie?: string, method = "GET") =>
    new NextRequest(`http://localhost${path}`, { method, headers: cookie ? { cookie: `crd_session=${cookie}` } : {} });

  it("refuses a missing, forged or non-owner cookie before the body is read", async () => {
    const forged = await sealData({ owner: true, version: 0 }, { password: "another-secret-that-is-long-enough-000000" });
    const device = await sealDevice("a".repeat(32), 0, SECRET);
    for (const cookie of [undefined, "x", forged, device]) {
      const res = await proxy(req("/api/scans", cookie, "POST"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-security-policy")).toMatch(/nonce-/);
    }
    const page = await proxy(req("/items", "fake"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toMatch(/\/login$/);
  });
  it("lets a genuine owner session through with a fresh nonce", async () => {
    const cookie = await sealData({ owner: true, version: 0, since: 1 }, { password: SECRET });
    const a = await proxy(req("/api/scans", cookie, "POST"));
    const b = await proxy(req("/", cookie));
    expect(a.status).toBe(200);
    const nonceOf = (r: Response) => /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });
  it("lets anyone open the public pages", async () => {
    expect((await proxy(req("/login"))).status).toBe(200);
    expect((await proxy(req("/api/health"))).status).toBe(200);
  });
});

describe("contentSecurityPolicy", () => {
  it("uses the nonce for scripts and never allows inline script without it", () => {
    const csp = contentSecurityPolicy("abc", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy("abc", true)).toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
