import { describe, expect, it } from "vitest";
import { addressAlwaysUnknown, connectionReport, UNKNOWN_ADDRESS_WARNING } from "./connection";

const behindApache = new Headers({
  host: "127.0.0.1:3210",
  "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2",
  "x-forwarded-host": "cards.example.com",
  "x-forwarded-proto": "https",
});

describe("connectionReport", () => {
  it("shows the headers and the address used for sign-in limits", () => {
    const r = connectionReport(behindApache, { hops: 2, appOrigin: "https://cards.example.com" });
    expect(r).toMatchObject({
      forwardedFor: "6.6.6.6, 203.0.113.9, 10.0.0.2", forwardedHost: "cards.example.com", forwardedProto: "https",
      host: "127.0.0.1:3210", hops: 2, signInIp: "203.0.113.9", appOrigin: "matches",
    });
  });
  it("reports unknown with 0 hops and a missing APP_ORIGIN", () => {
    const r = connectionReport(behindApache, { hops: 0 });
    expect(r.signInIp).toBe("unknown");
    expect(r.appOrigin).toBe("not_set");
  });
  it("notices an APP_ORIGIN that does not match this visit", () => {
    expect(connectionReport(behindApache, { hops: 1, appOrigin: "https://other.example.com" })).toMatchObject({
      appOrigin: "differs", visitHost: "cards.example.com",
    });
    expect(connectionReport(behindApache, { hops: 1, appOrigin: "http://cards.example.com" }).appOrigin).toBe("differs");
  });
  it("treats an http last hop as a match for an https address (TLS ends at Cloudflare)", () => {
    const tunnel = new Headers({ host: "cards.example.com", "x-forwarded-host": "cards.example.com", "x-forwarded-proto": "http" });
    expect(connectionReport(tunnel, { hops: 1, appOrigin: "https://cards.example.com" }).appOrigin).toBe("matches");
  });
  it("shows CLIENT_IP_HEADER, its value on this visit, and the address used", () => {
    const h = new Headers({ "cf-connecting-ip": "2001:db8:1:2::9", "x-forwarded-for": "6.6.6.6" });
    expect(connectionReport(h, { hops: 1, clientIpHeader: "CF-Connecting-IP" })).toMatchObject({
      clientIpHeader: "cf-connecting-ip", clientIpHeaderValue: "2001:db8:1:2::9", signInIp: "2001:db8:1:2::/64",
    });
    expect(connectionReport(h, { hops: 1 })).toMatchObject({ clientIpHeader: null, clientIpHeaderValue: null, signInIp: "6.6.6.6" });
    expect(connectionReport(new Headers(), { hops: 1, clientIpHeader: "cf-connecting-ip" })).toMatchObject({
      clientIpHeader: "cf-connecting-ip", clientIpHeaderValue: null, signInIp: "unknown",
    });
  });
  it("handles missing headers and cuts very long ones", () => {
    const r = connectionReport(new Headers({ "x-forwarded-for": "1".repeat(1000) }), { hops: 1 });
    expect(r.forwardedFor?.length).toBeLessThan(310);
    expect(r).toMatchObject({ forwardedHost: null, forwardedProto: null, host: null, signInIp: "unknown", visitHost: null });
  });
});

describe("addressAlwaysUnknown", () => {
  it("is true only in production with no hops and no header", () => {
    expect(addressAlwaysUnknown({ nodeEnv: "production", hops: 0 })).toBe(true);
    expect(addressAlwaysUnknown({ nodeEnv: "production", hops: 1 })).toBe(false);
    expect(addressAlwaysUnknown({ nodeEnv: "production", hops: 0, clientIpHeader: "cf-connecting-ip" })).toBe(false);
    expect(addressAlwaysUnknown({ nodeEnv: "development", hops: 0 })).toBe(false);
  });
  it("has a warning that names both settings and no dashes", () => {
    expect(UNKNOWN_ADDRESS_WARNING).toMatch(/TRUST_PROXY_HOPS/);
    expect(UNKNOWN_ADDRESS_WARNING).toMatch(/CLIENT_IP_HEADER/);
    expect(UNKNOWN_ADDRESS_WARNING).not.toMatch(/[\u2013\u2014]/);
  });
});
