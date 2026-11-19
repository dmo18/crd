import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { outsideState, outsideUsage } from "@/db/schema";
import type { SourceId } from "./sources";

/**
 * Counters per source and UTC day (`outside_usage`) and the stored state of
 * each source (`outside_state`: switch, pause, last good call, last error).
 * The last error is a few plain words, never a URL, a key or an answer body.
 */

export type UsageCounts = {
  calls: number;
  storeHits: number;
  errors: number;
  slowDowns: number;
  skipped: number;
  waitMs: number;
};

export type UsageDay = UsageCounts & { day: string };

const ZERO: UsageCounts = { calls: 0, storeHits: 0, errors: 0, slowDowns: 0, skipped: 0, waitMs: 0 };

/** "2026-11-16" for a time in ms. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds to the counters of one source and day. */
export function bumpUsage(db: Db, source: SourceId, nowMs: number, add: Partial<UsageCounts>): void {
  const values = { ...ZERO, ...add };
  db.insert(outsideUsage)
    .values({ source, day: utcDay(nowMs), ...values })
    .onConflictDoUpdate({
      target: [outsideUsage.source, outsideUsage.day],
      set: {
        calls: sql`${outsideUsage.calls} + ${values.calls}`,
        storeHits: sql`${outsideUsage.storeHits} + ${values.storeHits}`,
        errors: sql`${outsideUsage.errors} + ${values.errors}`,
        slowDowns: sql`${outsideUsage.slowDowns} + ${values.slowDowns}`,
        skipped: sql`${outsideUsage.skipped} + ${values.skipped}`,
        waitMs: sql`${outsideUsage.waitMs} + ${values.waitMs}`,
      },
    })
    .run();
}

/** Counters for one source and day (zeros when nothing happened). */
export function usageOn(db: Db, source: SourceId, day: string): UsageCounts {
  const row = db.select().from(outsideUsage).where(and(eq(outsideUsage.source, source), eq(outsideUsage.day, day))).get();
  if (!row) return { ...ZERO };
  return { calls: row.calls, storeHits: row.storeHits, errors: row.errors, slowDowns: row.slowDowns, skipped: row.skipped, waitMs: row.waitMs };
}

/** The last `days` days, newest first, with zeros for quiet days. */
export function usageDays(db: Db, source: SourceId, nowMs: number, days = 7): UsageDay[] {
  const list = Array.from({ length: days }, (_, i) => utcDay(nowMs - i * 86_400_000));
  const rows = db.select().from(outsideUsage)
    .where(and(eq(outsideUsage.source, source), gte(outsideUsage.day, list[list.length - 1])))
    .orderBy(desc(outsideUsage.day)).all();
  return list.map((day) => {
    const r = rows.find((x) => x.day === day);
    return r
      ? { day, calls: r.calls, storeHits: r.storeHits, errors: r.errors, slowDowns: r.slowDowns, skipped: r.skipped, waitMs: r.waitMs }
      : { day, ...ZERO };
  });
}

export type SourceState = {
  enabled: boolean;
  pausedUntil: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
};

/** A missing row means switched on and never used. */
export function getSourceState(db: Db, source: SourceId): SourceState {
  const row = db.select().from(outsideState).where(eq(outsideState.source, source)).get();
  return {
    enabled: row?.enabled ?? true,
    pausedUntil: row?.pausedUntil ?? null,
    lastOkAt: row?.lastOkAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

type StatePatch = Partial<{ enabled: boolean; pausedUntil: Date | null; lastOkAt: Date | null; lastError: string | null }>;

function patchState(db: Db, source: SourceId, nowMs: number, patch: StatePatch): void {
  const updatedAt = new Date(nowMs);
  db.insert(outsideState)
    .values({ source, ...patch, updatedAt })
    .onConflictDoUpdate({ target: outsideState.source, set: { ...patch, updatedAt } })
    .run();
}

/** The owner's switch. Off means no call at all to this source. */
export function setSourceEnabled(db: Db, source: SourceId, enabled: boolean, nowMs = Date.now()): void {
  patchState(db, source, nowMs, { enabled });
}

/** Stores a pause so a restart does not forget it. */
export function pauseSource(db: Db, source: SourceId, untilMs: number, reason: string, nowMs: number): void {
  patchState(db, source, nowMs, { pausedUntil: new Date(untilMs), lastError: reason.slice(0, 120) });
}

/** Ends a pause early (tests, or the owner later). */
export function clearPause(db: Db, source: SourceId, nowMs = Date.now()): void {
  patchState(db, source, nowMs, { pausedUntil: null });
}

export function recordOk(db: Db, source: SourceId, nowMs: number): void {
  patchState(db, source, nowMs, { lastOkAt: new Date(nowMs) });
}

export function recordError(db: Db, source: SourceId, reason: string, nowMs: number): void {
  patchState(db, source, nowMs, { lastError: reason.slice(0, 120) });
}
