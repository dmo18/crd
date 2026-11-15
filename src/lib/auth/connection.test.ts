import { describe, expect, it } from "vitest";
import { connectionReport } from "./connection";

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
  it("handles missing headers and cuts very long ones", () => {
    const r = connectionReport(new Headers({ "x-forwarded-for": "1".repeat(1000) }), { hops: 1 });
    expect(r.forwardedFor?.length).toBeLessThan(310);
    expect(r).toMatchObject({ forwardedHost: null, forwardedProto: null, host: null, signInIp: "unknown", visitHost: null });
  });
});
