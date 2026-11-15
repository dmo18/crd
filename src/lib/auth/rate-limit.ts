import { isIP } from "node:net";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { loginAttempts, type AttemptKind } from "@/db/schema";

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

/** Header names are letters, digits and dashes, stored lowercase. */
export const CLIENT_IP_HEADER_PATTERN = /^[a-z0-9-]{1,64}$/i;

/** The 8 sixteen-bit groups of an IPv6 address (already checked by isIP), or null. */
function ipv6Groups(addr: string): number[] | null {
  if (addr.includes("%")) return null; // zone ids are not visitor addresses
  let text = addr;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = tail.split(".").map(Number);
    if (parts.length !== 4) return null;
    text = `${text.slice(0, lastColon + 1)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The key used for limits. IPv4 stays as is. An IPv4-mapped IPv6 address
 * (::ffff:1.2.3.4) is a plain IPv4 visitor. Any other IPv6 address becomes its
 * /64 network, like "2001:db8:1:2::/64", because one person usually controls a
 * whole /64 and could otherwise get a fresh address for every try.
 */
function limitKey(addr: string): string {
  const kind = isIP(addr);
  if (kind === 0) return "unknown";
  if (kind === 4) return addr;
  const g = ipv6Groups(addr);
  if (!g) return "unknown";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The address used for sign-in limits.
 *
 * headerName set (CLIENT_IP_HEADER): ONLY that header is read, its first
 * entry, and TRUST_PROXY_HOPS is ignored. Anyone who can reach the server
 * directly could write that header themselves, so set it only when the server
 * is reachable solely through the proxy that writes it (for example a
 * Cloudflare Tunnel with no open ports, header cf-connecting-ip).
 *
 * Otherwise, hops = 0: X-Forwarded-For is not trusted at all. Next.js does not
 * expose the socket address separately (it only copies it into X-Forwarded-For
 * when the header is missing, which a visitor could fake), so the answer is
 * "unknown".
 *
 * hops = N: each trusted proxy appends the address it received the request
 * from, so the Nth entry from the right was written by the Nth trusted proxy
 * and is the first one a visitor cannot forge. Anything further left is
 * ignored. The entry must look like an IPv4 or IPv6 address.
 *
 * Either way an IPv6 address is returned as its /64 network (see limitKey).
 */
export function clientIp(headers: Headers, hops: number, headerName?: string): string {
  if (headerName) {
    if (!CLIENT_IP_HEADER_PATTERN.test(headerName)) return "unknown";
    const raw = headers.get(headerName.toLowerCase());
    if (!raw || raw.length > 2000) return "unknown";
    return limitKey(raw.split(",")[0]!.trim());
  }
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_TRUST_PROXY_HOPS) return "unknown";
  const raw = headers.get("x-forwarded-for");
  if (!raw || raw.length > 2000) return "unknown";
  const entries = raw.split(",").map((s) => s.trim());
  const pick = entries[entries.length - hops];
  if (!pick) return "unknown";
  return limitKey(pick);
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

export function recordAttempt(
  ip: string, success: boolean, db: Db = getDb(), now: Date = new Date(), kind: AttemptKind = "login",
): number {
  return db.insert(loginAttempts).values({ ip, success, kind, createdAt: now }).returning({ id: loginAttempts.id }).get().id;
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
 * `kind` only marks what the attempt was for: sign-in, first-run setup and
 * password changes all count toward the same per-address and global limits.
 */
export function beginAttempt(
  ip: string, db: Db = getDb(), now: Date = new Date(), kind: AttemptKind = "login",
): BeginResult {
  counter.__crdAttemptCalls = ((counter.__crdAttemptCalls ?? 0) + 1) % PRUNE_EVERY;
  const prune = counter.__crdAttemptCalls === 1;
  return db.transaction((tx): BeginResult => {
    const t = tx as unknown as Db;
    if (prune) pruneLoginAttempts(t, now);
    const lock = currentLock(ip, t, now);
    if (lock) return { ok: false, lock };
    return { ok: true, id: recordAttempt(ip, false, t, now, kind) };
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
