import { createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { authState, ownerSettings } from "@/db/schema";
import { env } from "@/lib/env";

export const MAX_PASSWORD_LENGTH = 200;
export const MIN_NEW_PASSWORD_LENGTH = 16;
export const BCRYPT_COST = 12;
/**
 * Starting session version for a password kept in the server settings, used
 * until "Sign out all other devices" first raises it. Database versions start at 1.
 */
export const ENV_SESSION_VERSION = 0;

/** Session version for a password in the server settings: kept in auth_state, 0 when no row exists yet. */
function envSessionVersion(db: Db): number {
  return db.select({ v: authState.envSessionVersion }).from(authState).where(eq(authState.id, 1)).get()?.v ?? ENV_SESSION_VERSION;
}

export type PasswordSource =
  | { source: "env"; hash: string; version: number }
  | { source: "db"; hash: string; version: number }
  | { source: "none" };

/**
 * Where the owner password lives. OWNER_PASSWORD_HASH_B64 wins when set, so
 * installs that already use it keep working. Otherwise the row saved by the
 * first-run setup is used. "none" means no one can sign in until setup.
 */
export function passwordSource(db: Db = getDb()): PasswordSource {
  const fromEnv = env().OWNER_PASSWORD_HASH_B64;
  if (fromEnv) {
    return { source: "env", hash: Buffer.from(fromEnv, "base64").toString("utf8"), version: envSessionVersion(db) };
  }
  const row = db
    .select({ hash: ownerSettings.passwordHash, version: ownerSettings.sessionVersion })
    .from(ownerSettings)
    .where(eq(ownerSettings.id, 1))
    .get();
  return row ? { source: "db", hash: row.hash, version: row.version } : { source: "none" };
}

/** The session version a signed-in device must carry, or null when no password exists. */
export function currentSessionVersion(db: Db = getDb()): number | null {
  const s = passwordSource(db);
  return s.source === "none" ? null : s.version;
}

function usable(plain: unknown): plain is string {
  return typeof plain === "string" && plain.length > 0 && plain.length <= MAX_PASSWORD_LENGTH;
}

/**
 * Checks `plain` against the owner password. Returns the session version to
 * store on success, or null. Never logs inputs.
 */
export async function checkOwnerPassword(plain: unknown, db: Db = getDb()): Promise<number | null> {
  if (!usable(plain)) return null;
  try {
    const s = passwordSource(db);
    if (s.source === "none") return null;
    return (await bcrypt.compare(plain, s.hash)) ? s.version : null;
  } catch {
    return null;
  }
}

/** True only when `plain` matches the owner password. */
export async function verifyPassword(plain: string, db?: Db): Promise<boolean> {
  return (await checkOwnerPassword(plain, db)) !== null;
}

export function hashNewPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Compares a typed setup code with the real one in constant time. Both are
 * hashed first so the buffers always have the same length.
 */
export function setupCodeMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** /setup exists only while no password is set anywhere and SETUP_CODE is set. */
export function setupAvailable(db: Db = getDb()): boolean {
  return Boolean(env().SETUP_CODE) && passwordSource(db).source === "none";
}

/**
 * Saves the first owner password. Runs in one write transaction and relies on
 * the primary key, so two racing requests cannot both set it. Returns the new
 * session version (1), or null when a password already exists.
 */
export function createOwnerPassword(hash: string, db: Db = getDb(), now: Date = new Date()): number | null {
  try {
    return db.transaction((tx) => {
      if (env().OWNER_PASSWORD_HASH_B64) return null;
      if (tx.select({ id: ownerSettings.id }).from(ownerSettings).get()) return null;
      // A plain insert: a second row with id 1 is refused by the database.
      return tx.insert(ownerSettings).values({ id: 1, passwordHash: hash, sessionVersion: 1, updatedAt: now })
        .returning({ version: ownerSettings.sessionVersion }).get().version;
    }, { behavior: "immediate" });
  } catch (err) {
    if (err instanceof Error && /constraint/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Replaces the password kept in the database and raises the session version,
 * which signs out every device still holding the old one. Only succeeds when
 * the version is still `expectedVersion` (no change happened in between).
 * Returns the new version, or null.
 */
export function changeOwnerPassword(expectedVersion: number, hash: string, db: Db = getDb(), now: Date = new Date()): number | null {
  const row = db
    .update(ownerSettings)
    .set({ passwordHash: hash, sessionVersion: sql`${ownerSettings.sessionVersion} + 1`, updatedAt: now })
    .where(and(eq(ownerSettings.id, 1), eq(ownerSettings.sessionVersion, expectedVersion)))
    .returning({ version: ownerSettings.sessionVersion })
    .get();
  return row?.version ?? null;
}

/**
 * Raises the session version without changing the password, which signs out
 * every device still holding the old one, wherever the password lives. Only
 * succeeds when the version is still `expectedVersion`. Returns the new
 * version, or null.
 */
export function bumpSessionVersion(expectedVersion: number, db: Db = getDb(), now: Date = new Date()): number | null {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const s = passwordSource(t);
    if (s.source === "none" || s.version !== expectedVersion) return null;
    if (s.source === "db") {
      return t.update(ownerSettings)
        .set({ sessionVersion: sql`${ownerSettings.sessionVersion} + 1`, updatedAt: now })
        .where(and(eq(ownerSettings.id, 1), eq(ownerSettings.sessionVersion, expectedVersion)))
        .returning({ version: ownerSettings.sessionVersion }).get()?.version ?? null;
    }
    return t.insert(authState).values({ id: 1, envSessionVersion: expectedVersion + 1, updatedAt: now })
      .onConflictDoUpdate({ target: authState.id, set: { envSessionVersion: expectedVersion + 1, updatedAt: now } })
      .returning({ version: authState.envSessionVersion }).get().version;
  }, { behavior: "immediate" });
}

const SHORT = `Use at least ${MIN_NEW_PASSWORD_LENGTH} characters.`;
const LONG = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;

/** A new password typed twice. The messages are shown to the owner. */
export const newPasswordSchema = z
  .object({
    password: z.string(SHORT).min(MIN_NEW_PASSWORD_LENGTH, SHORT).max(MAX_PASSWORD_LENGTH, LONG),
    confirm: z.string("Type the new password a second time."),
  })
  .refine((v) => v.password === v.confirm, { message: "The two new passwords are not the same.", path: ["confirm"] });

/** First problem with a new password, as a plain message, or null when fine. */
export function newPasswordProblem(input: { password: unknown; confirm: unknown }): string | null {
  const parsed = newPasswordSchema.safeParse(input);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? SHORT);
}
