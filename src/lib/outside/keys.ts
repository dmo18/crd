import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { connectionKeys } from "@/db/schema";
import { settingsSecret } from "@/lib/env";
import { SOURCES, type SourceId } from "./sources";

/**
 * Keys for outside sources, locked in the database (`connection_keys`).
 * Design: docs/PLAN.md, Milestone 10, "Connections screen and keys".
 *
 * - AES-256-GCM, a fresh random 12 byte iv on every save, the source id as
 *   additional authenticated data.
 * - The 32 byte key comes from HKDF-SHA256 over SETTINGS_KEY (else
 *   SESSION_SECRET), salt `crd-connections-v1`, info `key:<source id>`.
 * - Write only: nothing here returns a key except `openKey`, which only the
 *   gate calls, at call time, inside the server. Nothing here logs.
 * - A key that cannot be opened (the setting changed, the row was changed)
 *   gives null: "This key must be entered again". Never a crash.
 */

export const KEY_MIN = 16;
export const KEY_MAX = 200;
const SALT = "crd-connections-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(source: SourceId, secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, SALT, `key:${source}`, 32));
}

export type SealedKey = { ciphertext: string; iv: string; authTag: string };

/** Locks one key. Exported for tests. */
export function sealKey(source: SourceId, plain: string, secret: string): SealedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(source, secret), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(source, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

/** Opens one key, or null when anything does not match. Never throws. Exported for tests. */
export function openSealed(source: SourceId, sealed: SealedKey, secret: string): string | null {
  try {
    const iv = Buffer.from(sealed.iv, "base64");
    const tag = Buffer.from(sealed.authTag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(source, secret), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(source, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The shape rule of a source, checked before saving. Messages never repeat what was typed. */
export function keySchema(source: SourceId) {
  const rule = SOURCES[source].key;
  return z.string()
    .trim()
    .min(KEY_MIN, `A key has at least ${KEY_MIN} characters.`)
    .max(KEY_MAX, `A key has at most ${KEY_MAX} characters.`)
    .regex(rule?.shape ?? /^[\x21-\x7e]+$/, rule?.hint ?? "This does not look like a key.");
}

export type SaveKeyResult = { ok: true } | { ok: false; message: string };

/** Checks and locks a pasted key, replacing any saved one. */
export function saveKey(db: Db, source: SourceId, raw: unknown, now = new Date(), secret = settingsSecret()): SaveKeyResult {
  if (!SOURCES[source].needsKey) return { ok: false, message: "This connection does not use a key." };
  const parsed = keySchema(source).safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "This does not look like a key." };
  const plain = parsed.data;
  const sealed = sealKey(source, plain, secret);
  const values = { ...sealed, last4: plain.slice(-4), savedAt: now, lastTestAt: null, lastTestResult: null };
  db.insert(connectionKeys).values({ source, ...values })
    .onConflictDoUpdate({ target: connectionKeys.source, set: values }).run();
  return { ok: true };
}

/** Removes the saved key. True when there was one. */
export function removeKey(db: Db, source: SourceId): boolean {
  return db.delete(connectionKeys).where(eq(connectionKeys.source, source)).run().changes > 0;
}

/**
 * The key itself, for the gate only, at call time. Null when none is saved
 * or it cannot be opened. Never send this to the browser or a log.
 */
export function openKey(db: Db, source: SourceId, secret = settingsSecret()): string | null {
  const row = db.select().from(connectionKeys).where(eq(connectionKeys.source, source)).get();
  if (!row) return null;
  return openSealed(source, row, secret);
}

/** What the screen may show about a key. Never the key; `last4` only for the screen itself. */
export type KeyStatus =
  | { state: "none" }
  | { state: "saved"; last4: string; savedAt: Date; lastTestAt: Date | null; lastTestOk: boolean | null }
  | { state: "enter_again"; savedAt: Date };

export function keyStatus(db: Db, source: SourceId, secret = settingsSecret()): KeyStatus {
  const row = db.select().from(connectionKeys).where(eq(connectionKeys.source, source)).get();
  if (!row) return { state: "none" };
  if (openSealed(source, row, secret) === null) return { state: "enter_again", savedAt: row.savedAt };
  const lastTestOk = row.lastTestResult === "ok" ? true : row.lastTestResult === "failed" ? false : null;
  return { state: "saved", last4: row.last4, savedAt: row.savedAt, lastTestAt: row.lastTestAt, lastTestOk };
}

/** Stores only whether the last test worked, and when. */
export function recordKeyTest(db: Db, source: SourceId, ok: boolean, now = new Date()): void {
  db.update(connectionKeys).set({ lastTestAt: now, lastTestResult: ok ? "ok" : "failed" })
    .where(eq(connectionKeys.source, source)).run();
}
