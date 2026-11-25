import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { ITEM_KINDS, items, type Item, type ItemKind } from "@/db/schema";
import { goneItem, liveItem } from "./live";
import { gradedCond, rawCond } from "./query";

/** Per-unit value: the owner's figure wins, then the estimate, else 0. */
const unitValue = sql`coalesce(${items.manualValueCents}, ${items.estValueCents}, 0)`;
/** Per-unit value, null when the item has none. */
const unitValueOrNull = sql`coalesce(${items.manualValueCents}, ${items.estValueCents})`;

export type KindStat = { kind: ItemKind; rows: number; units: number; valueCents: number };

export function kindBreakdown(db: Db = getDb()): KindStat[] {
  const found = db
    .select({
      kind: items.kind,
      rows: sql<number>`count(*)`,
      units: sql<number>`coalesce(sum(${items.quantity}), 0)`,
      valueCents: sql<number>`coalesce(sum(${unitValue} * ${items.quantity}), 0)`,
    })
    .from(items)
    .where(liveItem)
    .groupBy(items.kind)
    .all();
  return ITEM_KINDS.map((kind) => {
    const f = found.find((r) => r.kind === kind);
    return { kind, rows: Number(f?.rows ?? 0), units: Number(f?.units ?? 0), valueCents: Number(f?.valueCents ?? 0) };
  });
}

/** Items with the highest per-unit value. Items with no value are left out. */
export function topItems(limit: number, db: Db = getDb()): Item[] {
  return db
    .select()
    .from(items)
    .where(and(liveItem, sql`${unitValueOrNull} is not null`))
    .orderBy(desc(unitValueOrNull), desc(items.id))
    .limit(limit)
    .all();
}

export type Highlights = {
  rookies: number;
  keyCards: number;
  worthGrading: number;
  needsReview: number;
  noValue: number;
  sampleValued: number;
};

export function highlights(db: Db = getDb()): Highlights {
  const r = db
    .select({
      rookies: sql<number>`coalesce(sum(${items.isRookie}), 0)`,
      keyCards: sql<number>`coalesce(sum(${inArray(items.rarityTier, ["key", "grail"])}), 0)`,
      worthGrading: sql<number>`coalesce(sum(${items.worthGrading}), 0)`,
      needsReview: sql<number>`coalesce(sum(${eq(items.status, "needs_review")}), 0)`,
      noValue: sql<number>`coalesce(sum(${isNull(items.manualValueCents)} and ${isNull(items.estValueCents)}), 0)`,
      sampleValued: sql<number>`coalesce(sum(${isNull(items.manualValueCents)} and ${eq(items.valueSource, "sample")}), 0)`,
    })
    .from(items)
    .where(liveItem)
    .get();
  return {
    rookies: Number(r?.rookies ?? 0),
    keyCards: Number(r?.keyCards ?? 0),
    worthGrading: Number(r?.worthGrading ?? 0),
    needsReview: Number(r?.needsReview ?? 0),
    noValue: Number(r?.noValue ?? 0),
    sampleValued: Number(r?.sampleValued ?? 0),
  };
}

export type DecadeStat = { label: string; units: number; valueCents: number };

/** Units and value by decade of year. Unknown year comes last. */
export function decadeBreakdown(db: Db = getDb()): DecadeStat[] {
  const decade = sql<number | null>`case when ${items.year} is null then null else (${items.year} / 10) * 10 end`;
  const rows = db
    .select({
      decade,
      units: sql<number>`coalesce(sum(${items.quantity}), 0)`,
      valueCents: sql<number>`coalesce(sum(${unitValue} * ${items.quantity}), 0)`,
    })
    .from(items)
    .where(liveItem)
    .groupBy(decade)
    .orderBy(sql`${decade} is null`, decade)
    .all();
  return rows.map((r) => ({
    label: r.decade == null ? "Unknown" : `${r.decade}s`,
    units: Number(r.units),
    valueCents: Number(r.valueCents),
  }));
}

export function recentItems(limit: number, db: Db = getDb()): Item[] {
  return db.select().from(items).where(liveItem).orderBy(desc(items.createdAt), desc(items.id)).limit(limit).all();
}

export type GroupStat = { label: string; units: number; valueCents: number };
export const BREAKDOWN_TOP = 10;

/** The columns the Home breakdowns group by. `set` is the set name. */
const GROUP_COLUMNS = { sport: items.sport, player: items.player, team: items.team, set: items.setName } as const;
export type BreakdownBy = keyof typeof GROUP_COLUMNS;

/**
 * Units and value (the same rule as every other total: the owner's figure,
 * else the estimate, else 0, times the quantity) for each sport, player,
 * team or set, biggest value first. Blank names are left out. Names that
 * differ only in capitals or outer spaces count as one. `limit` cuts the list.
 */
export function breakdownBy(by: BreakdownBy, limit: number, db: Db = getDb()): GroupStat[] {
  const col = GROUP_COLUMNS[by];
  const key = sql`lower(trim(${col}))`;
  const units = sql<number>`coalesce(sum(${items.quantity}), 0)`;
  const valueCents = sql<number>`coalesce(sum(${unitValue} * ${items.quantity}), 0)`;
  return db
    .select({ label: sql<string>`min(trim(${col}))`, units, valueCents })
    .from(items)
    .where(and(liveItem, sql`nullif(trim(${col}), '') is not null`))
    .groupBy(key)
    .orderBy(desc(valueCents), desc(units), sql`min(trim(${col}))`)
    .limit(limit)
    .all()
    .map((r) => ({ label: r.label, units: Number(r.units), valueCents: Number(r.valueCents) }));
}

/** Graded against raw cards, with the rule the Inventory filters use (src/lib/items/query.ts). */
export function gradedSplit(db: Db = getDb()): { graded: GroupStat; raw: GroupStat } {
  const one = (label: string, cond: SQL): GroupStat => {
    const r = db.select({
      units: sql<number>`coalesce(sum(${items.quantity}), 0)`,
      valueCents: sql<number>`coalesce(sum(${unitValue} * ${items.quantity}), 0)`,
    }).from(items).where(and(liveItem, cond)).get();
    return { label, units: Number(r?.units ?? 0), valueCents: Number(r?.valueCents ?? 0) };
  };
  return { graded: one("Graded", gradedCond), raw: one("Raw", rawCond) };
}

/** Sold and removed items, not in Recently deleted: for the link on Home. */
export function goneCount(db: Db = getDb()): number {
  return Number(db.select({ n: sql<number>`count(*)` }).from(items).where(goneItem).get()?.n ?? 0);
}
