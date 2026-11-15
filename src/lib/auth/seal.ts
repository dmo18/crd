import { randomBytes } from "node:crypto";
import { sealData, unsealData } from "iron-session";

/**
 * Signed cookie helpers with no Next.js imports, so the proxy can use them.
 * iron-session seals with AES and an HMAC over SESSION_SECRET and checks the
 * HMAC in constant time when unsealing; a forged or edited cookie reads as
 * empty.
 */

export const SESSION_COOKIE = "crd_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/** A browser that signed in before. Lets it skip the limits strangers can trigger. */
export const DEVICE_COOKIE = "crd_device";
export const DEVICE_MAX_AGE = 60 * 60 * 24 * 180;

const DEVICE_ID = /^[0-9a-f]{32}$/;

type DeviceSeal = { p?: unknown; d?: unknown; v?: unknown };

export function newDeviceId(): string {
  return randomBytes(16).toString("hex");
}

/** Seals a trusted-device cookie for `deviceId`, bound to the current session version. */
export function sealDevice(deviceId: string, version: number, secret: string): Promise<string> {
  return sealData({ p: "device", d: deviceId, v: version }, { password: secret, ttl: DEVICE_MAX_AGE });
}

/**
 * The device id in a trusted-device cookie, or null when the cookie is
 * missing, forged, expired, not a device cookie, or from before the session
 * version changed (a password change or "Sign out all other devices").
 */
export async function readDevice(cookie: string | undefined, secret: string, version: number | null): Promise<string | null> {
  if (!cookie || version === null || cookie.length > 4096) return null;
  try {
    const data = await unsealData<DeviceSeal>(cookie, { password: secret, ttl: DEVICE_MAX_AGE });
    if (data.p !== "device" || typeof data.d !== "string" || !DEVICE_ID.test(data.d)) return null;
    return data.v === version ? data.d : null;
  } catch {
    return null;
  }
}

/**
 * True when the session cookie was sealed by this server for the owner. Does
 * not check the session version (that needs the database); requireOwner and
 * guardApi still do the full check. Used by the proxy to turn strangers away
 * before their request body is read.
 */
export async function sessionCookieLooksValid(cookie: string | undefined, secret: string): Promise<boolean> {
  if (!cookie || cookie.length > 4096) return false;
  try {
    const data = await unsealData<{ owner?: unknown; version?: unknown }>(cookie, { password: secret, ttl: SESSION_MAX_AGE });
    return data.owner === true && typeof data.version === "number";
  } catch {
    return false;
  }
}
