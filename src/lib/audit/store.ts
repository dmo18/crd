import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { auditEvents, SECURITY_AUDIT_EVENTS, type AuditEvent, type AuditOutcome } from "@/db/schema";
import { errorKind, log } from "@/lib/log";

const DAY = 24 * 60 * 60 * 1000;
/** Activity is kept this long. */
export const KEEP_AUDIT_MS = 365 * DAY;
/** Old activity is removed at most this often (per server process). */
export const PRUNE_AUDIT_EVERY_MS = DAY;
export const MAX_DETAIL = 200;
export const AUDIT_PAGE_SIZE = 50;

export type AuditEntry = {
  event: AuditEvent;
  outcome: AuditOutcome;
  ip: string;
  deviceId?: string | null;
  detail?: string | null;
};

export type AuditWriteOptions = {
  db?: Db;
  now?: Date;
  /** Skip the write when the same event from the same address was recorded this recently. */
  onceWithinMs?: number;
};

const holder = globalThis as unknown as { __crdAuditPrunedAt?: number };

/** For tests only: makes the next write prune. */
export function resetAuditPrune(): void {
  holder.__crdAuditPrunedAt = undefined;
}

/** Short, single-line text. */
export function cleanDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const s = detail.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 3)}...` : s;
}

/** Deletes activity older than 365 days. Returns how many rows went. */
export function pruneAudit(db: Db = getDb(), now: Date = new Date()): number {
  return db.delete(auditEvents).where(lt(auditEvents.at, new Date(now.getTime() - KEEP_AUDIT_MS))).run().changes;
}

/**
 * Records one event. Never throws: the activity log must not break sign-in
 * or any other action. Returns true when a row was written.
 */
export function recordAudit(entry: AuditEntry, opts: AuditWriteOptions = {}): boolean {
  try {
    const db = opts.db ?? getDb();
    const now = opts.now ?? new Date();
    const last = holder.__crdAuditPrunedAt;
    if (last === undefined || now.getTime() - last >= PRUNE_AUDIT_EVERY_MS) {
      holder.__crdAuditPrunedAt = now.getTime();
      pruneAudit(db, now);
    }
    const ip = entry.ip.slice(0, 64) || "unknown";
    if (opts.onceWithinMs) {
      const recent = db.select({ id: auditEvents.id }).from(auditEvents)
        .where(and(eq(auditEvents.event, entry.event), eq(auditEvents.ip, ip), gte(auditEvents.at, new Date(now.getTime() - opts.onceWithinMs))))
        .limit(1).get();
      if (recent) return false;
    }
    db.insert(auditEvents).values({
      at: now, event: entry.event, outcome: entry.outcome, ip,
      deviceId: entry.deviceId ?? null, detail: cleanDetail(entry.detail),
    }).run();
    return true;
  } catch (err) {
    log.error("audit_write_failed", { auditEvent: entry.event, error: errorKind(err) });
    return false;
  }
}

/** How many of these events happened since `since`. */
export function countAuditSince(events: readonly AuditEvent[], since: Date, db: Db = getDb()): number {
  const row = db.select({ n: count() }).from(auditEvents)
    .where(and(inArray(auditEvents.event, [...events]), gte(auditEvents.at, since))).get();
  return Number(row?.n ?? 0);
}

export const AUDIT_FILTERS = ["security", "all"] as const;
export type AuditFilter = (typeof AUDIT_FILTERS)[number];

export type AuditRow = typeof auditEvents.$inferSelect;

/** One page of activity, newest first. `page` starts at 1. */
export function listAudit(filter: AuditFilter, page: number, db: Db = getDb()): { rows: AuditRow[]; total: number; page: number; pages: number } {
  const where = filter === "security" ? inArray(auditEvents.event, [...SECURITY_AUDIT_EVENTS]) : undefined;
  const total = Number(db.select({ n: count() }).from(auditEvents).where(where).get()?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page)), pages);
  const rows = db.select().from(auditEvents).where(where)
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(AUDIT_PAGE_SIZE).offset((current - 1) * AUDIT_PAGE_SIZE).all();
  return { rows, total, page: current, pages };
}
