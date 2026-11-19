import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { collectionSnapshots, items } from "@/db/schema";
import { liveItem } from "@/lib/items/live";

/** The UTC day of a moment, as "YYYY-MM-DD". */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The whole collection's worth right now, over every item whatever its status
 * (items in Recently deleted are not counted).
 * Each unit counts at the owner's value when set, else the estimate, else 0.
 */
export function collectionTotals(db: Db = getDb()): { totalValueCents: number; itemCount: number; unitCount: number } {
  const row = db.select({
    totalValueCents: sql<number>`coalesce(sum(coalesce(${items.manualValueCents}, ${items.estValueCents}, 0) * ${items.quantity}), 0)`,
    itemCount: sql<number>`count(*)`,
    unitCount: sql<number>`coalesce(sum(${items.quantity}), 0)`,
  }).from(items).where(liveItem).get();
  return {
    totalValueCents: Number(row?.totalValueCents ?? 0),
    itemCount: Number(row?.itemCount ?? 0),
    unitCount: Number(row?.unitCount ?? 0),
  };
}

export type ValueSplit = {
  /** From the owner's own values. */
  ownCents: number;
  /** From the built-in price guide (rough). */
  guideCents: number;
  /** From any other estimate (older estimates, sample data). */
  otherCents: number;
};

/**
 * How the collection total splits by where each value came from. Uses the
 * same rule as collectionTotals, so the three parts always add up to its total.
 */
export function valueSplit(db: Db = getDb()): ValueSplit {
  const own = isNotNull(items.manualValueCents);
  const guide = and(isNull(items.manualValueCents), eq(items.valueSource, "price_guide"));
  const row = db.select({
    ownCents: sql<number>`coalesce(sum(case when ${own} then ${items.manualValueCents} * ${items.quantity} else 0 end), 0)`,
    guideCents: sql<number>`coalesce(sum(case when ${guide} then coalesce(${items.estValueCents}, 0) * ${items.quantity} else 0 end), 0)`,
    otherCents: sql<number>`coalesce(sum(case when ${own} or (${guide}) then 0 else coalesce(${items.estValueCents}, 0) * ${items.quantity} end), 0)`,
  }).from(items).where(liveItem).get();
  return { ownCents: Number(row?.ownCents ?? 0), guideCents: Number(row?.guideCents ?? 0), otherCents: Number(row?.otherCents ?? 0) };
}

/** Saves today's totals (UTC day). A second call on the same day replaces the row. */
export function recordSnapshot(db: Db = getDb(), now: Date = new Date()): void {
  const totals = collectionTotals(db);
  db.insert(collectionSnapshots)
    .values({ day: utcDay(now), ...totals })
    .onConflictDoUpdate({ target: collectionSnapshots.day, set: totals })
    .run();
}

/** Saved daily totals for the last `days` days including today, oldest first. Days without a row are skipped. */
export function getSnapshots(
  days: number,
  db: Db = getDb(),
  now: Date = new Date(),
): { day: string; totalValueCents: number; itemCount: number; unitCount: number }[] {
  if (!Number.isFinite(days) || days < 1) return [];
  const first = new Date(now.getTime());
  first.setUTCDate(first.getUTCDate() - (Math.floor(days) - 1));
  return db.select({
    day: collectionSnapshots.day,
    totalValueCents: collectionSnapshots.totalValueCents,
    itemCount: collectionSnapshots.itemCount,
    unitCount: collectionSnapshots.unitCount,
  }).from(collectionSnapshots)
    .where(and(gte(collectionSnapshots.day, utcDay(first)), lte(collectionSnapshots.day, utcDay(now))))
    .orderBy(asc(collectionSnapshots.day))
    .all();
}
