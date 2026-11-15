import { isIP } from "node:net";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { loginAttempts } from "@/db/schema";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Short lock: 5 failures from one address within 15 minutes lock it for 15 minutes. */
export const SHORT_WINDOW_MS = 15 * MINUTE;
export const SHORT_LOCK_MS = 15 * MINUTE;
export const MAX_FAILS_PER_IP = 5;
/** Long lock: 10 failures from one address within 24 hours lock it for 24 hours. */
export const LONG_WINDOW_MS = 24 * HOUR;
export const LONG_LOCK_MS = 24 * HOUR;
export const MAX_FAILS_PER_IP_LONG = 10;
/** Everyone together: this many failures in 15 minutes pause sign-in for all. */
export const GLOBAL_WINDOW_MS = 15 * MINUTE;
export const MAX_FAILS_GLOBAL = 300;
/** Rows older than this are deleted now and then. */
export const KEEP_ATTEMPTS_MS = 30 * 24 * HOUR;
export const PRUNE_EVERY = 100;

export const MAX_TRUST_PROXY_HOPS = 5;

/**
 * The address used for sign-in limits.
 *
 * hops = 0: X-Forwarded-For is not trusted at all. Next.js does not expose the
 * socket address separately (it only copies it into X-Forwarded-For when the
 * header is missing, which a visitor could fake), so the answer is "unknown".
 *
 * hops = N: each trusted proxy appends the address it received the request
 * from, so the Nth entry from the right was written by the Nth trusted proxy
 * and is the first one a visitor cannot forge. Anything further left is
 * ignored. The entry must look like an IPv4 or IPv6 address.
 */
export function clientIp(headers: Headers, hops: number): string {
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_TRUST_PROXY_HOPS) return "unknown";
  const raw = headers.get("x-forwarded-for");
  if (!raw || raw.length > 2000) return "unknown";
  const entries = raw.split(",").map((s) => s.trim());
  const pick = entries[entries.length - hops];
  if (!pick || isIP(pick) === 0) return "unknown";
  return pick.toLowerCase();
}

export type Lock = "short" | "long" | "global";

/** Failures from one address, newest first, at most `limit`, since `since`. */
function recentFailures(db: Db, ip: string, since: Date, limit: number): Date[] {
  return db
    .select({ at: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)))
    .orderBy(desc(loginAttempts.createdAt), desc(loginAttempts.id))
    .limit(limit)
    .all()
    .map((r) => r.at);
}

/**
 * True when `fails` (newest first) hold `max` failures within `windowMs` of
 * each other and the newest is less than `lockMs` ago. While locked nothing
 * new is booked, so the newest failure is the one that started the lock.
 */
function lockedBy(fails: Date[], max: number, windowMs: number, lockMs: number, now: Date): boolean {
  if (fails.length < max) return false;
  const newest = fails[0]!.getTime();
  const oldest = fails[max - 1]!.getTime();
  return newest - oldest <= windowMs && now.getTime() < newest + lockMs;
}

/** Which lock, if any, applies to this address right now. */
export function currentLock(ip: string, db: Db = getDb(), now: Date = new Date()): Lock | null {
  const longFails = recentFailures(db, ip, new Date(now.getTime() - LONG_WINDOW_MS - LONG_LOCK_MS), MAX_FAILS_PER_IP_LONG);
  if (lockedBy(longFails, MAX_FAILS_PER_IP_LONG, LONG_WINDOW_MS, LONG_LOCK_MS, now)) return "long";
  if (lockedBy(longFails, MAX_FAILS_PER_IP, SHORT_WINDOW_MS, SHORT_LOCK_MS, now)) return "short";
  const [all] = db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.success, false), gte(loginAttempts.createdAt, new Date(now.getTime() - GLOBAL_WINDOW_MS))))
    .all();
  return (all?.n ?? 0) >= MAX_FAILS_GLOBAL ? "global" : null;
}

/** True when this address, or everyone together, has failed too often recently. */
export function isRateLimited(ip: string, db: Db = getDb(), now: Date = new Date()): boolean {
  return currentLock(ip, db, now) !== null;
}

export function recordAttempt(ip: string, success: boolean, db: Db = getDb(), now: Date = new Date()): number {
  return db.insert(loginAttempts).values({ ip, success, createdAt: now }).returning({ id: loginAttempts.id }).get().id;
}

/** Deletes sign-in records older than 30 days. Returns how many were removed. */
export function pruneLoginAttempts(db: Db = getDb(), now: Date = new Date()): number {
  return db.delete(loginAttempts).where(lt(loginAttempts.createdAt, new Date(now.getTime() - KEEP_ATTEMPTS_MS))).run().changes;
}

const counter = globalThis as unknown as { __crdAttemptCalls?: number };

export type BeginResult = { ok: true; id: number } | { ok: false; lock: Lock };

/**
 * Checks the limits and books a failed attempt in one step, before the slow
 * password check runs, so a burst of parallel guesses cannot slip past.
 * Every 100th call also deletes old records, in the same transaction.
 */
export function beginAttempt(ip: string, db: Db = getDb(), now: Date = new Date()): BeginResult {
  counter.__crdAttemptCalls = ((counter.__crdAttemptCalls ?? 0) + 1) % PRUNE_EVERY;
  const prune = counter.__crdAttemptCalls === 1;
  return db.transaction((tx): BeginResult => {
    const t = tx as unknown as Db;
    if (prune) pruneLoginAttempts(t, now);
    const lock = currentLock(ip, t, now);
    if (lock) return { ok: false, lock };
    return { ok: true, id: recordAttempt(ip, false, t, now) };
  }, { behavior: "immediate" });
}

/** For tests only: makes the next beginAttempt call prune. */
export function resetPruneCounter(): void {
  counter.__crdAttemptCalls = 0;
}

/** Marks a booked attempt as a successful sign-in. */
export function markAttemptSucceeded(id: number, db: Db = getDb()): void {
  db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, id)).run();
}
