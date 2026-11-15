import { and, count, eq, gte } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { loginAttempts } from "@/db/schema";

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILS_PER_IP = 5;
export const MAX_FAILS_GLOBAL = 30;

/** First entry of x-forwarded-for, else "unknown". */
export function clientIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first.slice(0, 100) : "unknown";
}

/** True when this IP, or everyone together, has failed too often recently. */
export function isRateLimited(ip: string, db: Db = getDb(), now: Date = new Date()): boolean {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [perIp] = db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)))
    .all();
  if ((perIp?.n ?? 0) >= MAX_FAILS_PER_IP) return true;
  const [all] = db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)))
    .all();
  return (all?.n ?? 0) >= MAX_FAILS_GLOBAL;
}

export function recordAttempt(ip: string, success: boolean, db: Db = getDb(), now: Date = new Date()): number {
  return db.insert(loginAttempts).values({ ip, success, createdAt: now }).returning({ id: loginAttempts.id }).get().id;
}

/**
 * Checks the limit and books a failed attempt in one step, before the slow
 * password check runs, so a burst of parallel guesses cannot slip past.
 * Returns the attempt id, or null when the caller is locked out.
 */
export function beginAttempt(ip: string, db: Db = getDb(), now: Date = new Date()): number | null {
  return db.transaction((tx) => {
    if (isRateLimited(ip, tx as unknown as Db, now)) return null;
    return recordAttempt(ip, false, tx as unknown as Db, now);
  }, { behavior: "immediate" });
}

/** Marks a booked attempt as a successful sign-in. */
export function markAttemptSucceeded(id: number, db: Db = getDb()): void {
  db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, id)).run();
}
