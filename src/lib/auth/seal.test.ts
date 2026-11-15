import { sealData } from "iron-session";
import { describe, expect, it } from "vitest";
import { DEVICE_MAX_AGE, newDeviceId, readDevice, sealDevice, sessionCookieLooksValid } from "./seal";

const SECRET = "test-only-session-secret-0123456789abcdef";
const OTHER = "another-secret-that-is-long-enough-000000";

describe("trusted-device cookie", () => {
  it("lasts 180 days and reads back its id for the same session version", async () => {
    expect(DEVICE_MAX_AGE).toBe(180 * 24 * 60 * 60);
    const id = newDeviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const cookie = await sealDevice(id, 3, SECRET);
    expect(await readDevice(cookie, SECRET, 3)).toBe(id);
  });
  it("stops working when the session version changes (password change or sign out everywhere)", async () => {
    const cookie = await sealDevice(newDeviceId(), 3, SECRET);
    expect(await readDevice(cookie, SECRET, 4)).toBeNull();
    expect(await readDevice(cookie, SECRET, null)).toBeNull();
  });
  it("rejects forged, edited and foreign cookies", async () => {
    const cookie = await sealDevice(newDeviceId(), 1, SECRET);
    expect(await readDevice(cookie, OTHER, 1)).toBeNull();
    expect(await readDevice(`${cookie.slice(0, -2)}xx`, SECRET, 1)).toBeNull();
    expect(await readDevice("not a cookie", SECRET, 1)).toBeNull();
    expect(await readDevice(undefined, SECRET, 1)).toBeNull();
    // A session cookie is not a device cookie.
    const session = await sealData({ owner: true, version: 1 }, { password: SECRET });
    expect(await readDevice(session, SECRET, 1)).toBeNull();
    const badId = await sealData({ p: "device", d: "../../x", v: 1 }, { password: SECRET });
    expect(await readDevice(badId, SECRET, 1)).toBeNull();
  });
});

describe("sessionCookieLooksValid", () => {
  it("accepts only an owner session sealed with this secret", async () => {
    expect(await sessionCookieLooksValid(await sealData({ owner: true, version: 0 }, { password: SECRET }), SECRET)).toBe(true);
    expect(await sessionCookieLooksValid(await sealData({ owner: true, version: 0 }, { password: OTHER }), SECRET)).toBe(false);
    expect(await sessionCookieLooksValid(await sealData({ version: 0 }, { password: SECRET }), SECRET)).toBe(false);
    expect(await sessionCookieLooksValid(await sealDevice(newDeviceId(), 0, SECRET), SECRET)).toBe(false);
    expect(await sessionCookieLooksValid("anything", SECRET)).toBe(false);
    expect(await sessionCookieLooksValid(undefined, SECRET)).toBe(false);
  });
});
