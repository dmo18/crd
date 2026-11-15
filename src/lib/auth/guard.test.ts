import { describe, expect, it } from "vitest";
import { checkSameOrigin } from "./guard";

const req = (method: string, headers: Record<string, string>) =>
  new Request("http://localhost/api/x", { method, headers });

describe("checkSameOrigin", () => {
  it("allows GET and HEAD regardless", () => {
    expect(checkSameOrigin(req("GET", { origin: "http://evil.com", host: "a.com" }))).toBe(true);
    expect(checkSameOrigin(req("HEAD", { origin: "http://evil.com", host: "a.com" }))).toBe(true);
  });
  it("allows matching origin and host", () => {
    expect(checkSameOrigin(req("POST", { origin: "https://a.com", host: "a.com" }))).toBe(true);
  });
  it("rejects a different origin", () => {
    expect(checkSameOrigin(req("POST", { origin: "https://evil.com", host: "a.com" }))).toBe(false);
    expect(checkSameOrigin(req("DELETE", { origin: "not a url", host: "a.com" }))).toBe(false);
  });
  it("prefers x-forwarded-host", () => {
    expect(checkSameOrigin(req("POST", { origin: "https://a.com", host: "internal:3000", "x-forwarded-host": "a.com" }))).toBe(true);
    expect(checkSameOrigin(req("POST", { origin: "https://internal:3000", host: "internal:3000", "x-forwarded-host": "a.com" }))).toBe(false);
  });
  it("without Origin, uses sec-fetch-site", () => {
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(checkSameOrigin(req("POST", {}))).toBe(true);
  });
});
