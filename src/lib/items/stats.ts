import { desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { ITEM_KINDS, items, type Item, type ItemKind } from "@/db/schema";

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
    .where(sql`${unitValueOrNull} is not null`)
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
  return db.select().from(items).orderBy(desc(items.createdAt), desc(items.id)).limit(limit).all();
}
