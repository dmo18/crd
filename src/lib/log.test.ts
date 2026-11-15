import { afterEach, describe, expect, it } from "vitest";
import { errorKind, log, redact, requestIdFrom, setLogSink } from "./log";

afterEach(() => setLogSink());

const TELEGRAM = "123456789:AAHfakeTokenForTestsOnly_abcdefghijklmnop";
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl";

describe("redact", () => {
  it("drops values of secret fields whatever they hold", () => {
    const out = redact({
      password: "hunter2-hunter2", newPassword: "x", sessionSecret: "s", SESSION_SECRET: "s", token: "t",
      botToken: "t", cookie: "c", Cookie: "c", authorization: "Bearer abc", setupCode: "c", code: "c",
      passwordHash: "$2b$12$abc", apiKey: "k", ANTHROPIC_API_KEY: "k", photo: "p", photos: ["p"], image: "i",
      data: "d", body: "b", requestBody: "b", webhookUrl: DISCORD,
    });
    for (const v of Object.values(out)) expect(v).toBe("[redacted]");
  });

  it("strips secrets hidden inside safe-looking text", () => {
    const out = redact({
      url: `https://api.telegram.org/bot${TELEGRAM}/sendMessage`,
      where: `posting to ${DISCORD} failed`,
      header: "Bearer abc.def.ghi",
      sealed: "Fe26.2**0123456789abcdef*xyz",
      hash: "irrelevant",
      note: "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
      blob: "A".repeat(60),
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("AAHfakeToken");
    expect(text).not.toContain("fakeWebhookToken");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toContain("abcdefghijklmnopqrstuv");
    expect(text).not.toContain("A".repeat(60));
  });

  it("keeps safe fields, shortens long text and hides binary data", () => {
    const out = redact({ scanId: 7, ok: true, error: new Error("secret message"), at: new Date(0), long: "word ".repeat(100), buf: Buffer.from("x"), nested: { password: "p", count: 2 } });
    expect(out.scanId).toBe(7);
    expect(out.ok).toBe(true);
    expect(out.error).toBe("Error");
    expect(out.at).toBe("1970-01-01T00:00:00.000Z");
    expect(String(out.long).length).toBeLessThanOrEqual(203);
    expect(out.buf).toBe("[binary]");
    expect(out.nested).toEqual({ password: "[redacted]", count: 2 });
  });

  it("never throws, even on a field that throws when read", () => {
    const evil = { get boom() { throw new Error("no"); } };
    expect(() => redact(evil)).not.toThrow();
  });
});

describe("log", () => {
  it("writes one JSON line with time, level, event and the request id", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    log.warn("sign_in_blocked", { requestId: "0b9c6c1e-2d3f-4a5b-8c7d-112233445566", lock: "short", password: "typed" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: "warn", event: "sign_in_blocked", requestId: "0b9c6c1e-2d3f-4a5b-8c7d-112233445566", lock: "short", password: "[redacted]" });
    expect(Number.isNaN(Date.parse(line.time))).toBe(false);
    expect(lines[0]).not.toContain("typed");
  });

  it("drops a request id that does not look like one", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    log.info("x", { requestId: "bad id\nwith newline" });
    expect(JSON.parse(lines[0]!).requestId).toBeUndefined();
  });

  it("reads the request id header and names errors without their message", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "abc-123" }))).toBe("abc-123");
    expect(requestIdFrom(new Headers({ "x-request-id": "a b" }))).toBeUndefined();
    expect(errorKind(new TypeError("password was hunter2"))).toBe("TypeError");
    expect(errorKind("oops")).toBe("unknown error");
  });
});
