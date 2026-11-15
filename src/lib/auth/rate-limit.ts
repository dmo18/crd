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

export function recordAttempt(ip: string, success: boolean, db: Db = getDb(), now: Date = new Date()): void {
  db.insert(loginAttempts).values({ ip, success, createdAt: now }).run();
}
