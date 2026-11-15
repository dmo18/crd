import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { ITEM_KINDS, ITEM_STATUSES, RARITY_TIERS, SPORTS, items, type Item } from "@/db/schema";

export const PAGE_SIZE = 40;
export const SORTS = ["newest", "oldest", "value_desc", "value_asc", "year_asc", "year_desc", "player", "title"] as const;
export type InventorySort = (typeof SORTS)[number];

/** URL params can repeat (arrays). Use the first value. */
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const intText = (min: number, max: number) =>
  z.preprocess(first, z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(min).max(max)));

/** Parses URL search params. Anything invalid quietly counts as "not set". */
export const inventoryFilterSchema = z.object({
  q: z.preprocess(first, z.string().trim().max(100).transform((s) => s || undefined)).optional().catch(undefined),
  kind: z.preprocess(first, z.enum(ITEM_KINDS)).optional().catch(undefined),
  sport: z.preprocess(first, z.enum(SPORTS)).optional().catch(undefined),
  status: z.preprocess(first, z.enum(ITEM_STATUSES)).optional().catch(undefined),
  tier: z.preprocess(first, z.enum(RARITY_TIERS)).optional().catch(undefined),
  rookie: z.preprocess(first, z.literal("1").transform(() => true as const)).optional().catch(undefined),
  yearFrom: intText(1860, 2100).optional().catch(undefined),
  yearTo: intText(1860, 2100).optional().catch(undefined),
  location: z.preprocess(first, z.union([z.literal("none"), intText(1, 2_000_000_000)])).optional().catch(undefined),
  sort: z.preprocess(first, z.enum(SORTS)).catch("newest"),
  page: intText(1, 10000).catch(1),
});
export type InventoryFilters = z.infer<typeof inventoryFilterSchema>;

export type InventoryResult = {
  rows: Item[];
  total: number;
  totalUnits: number;
  totalValueCents: number;
  page: number;
  pageCount: number;
};

const SEARCH_COLUMNS = [
  items.title, items.player, items.team, items.brand, items.setName,
  items.cardNumber, items.variation, items.notes, items.description,
];

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function where(f: InventoryFilters): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const words = (f.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const pattern = `%${escapeLike(w)}%`;
    conds.push(or(...SEARCH_COLUMNS.map((c) => sql`${c} like ${pattern} escape '\\'`)));
  }
  if (f.kind) conds.push(eq(items.kind, f.kind));
  if (f.sport) conds.push(eq(items.sport, f.sport));
  if (f.status) conds.push(eq(items.status, f.status));
  if (f.tier) conds.push(eq(items.rarityTier, f.tier));
  if (f.rookie) conds.push(eq(items.isRookie, true));
  if (f.yearFrom != null) conds.push(gte(items.year, f.yearFrom));
  if (f.yearTo != null) conds.push(lte(items.year, f.yearTo));
  if (f.location === "none") conds.push(isNull(items.locationId));
  else if (f.location != null) conds.push(eq(items.locationId, f.location));
  return and(...conds);
}

const value = sql`coalesce(${items.manualValueCents}, ${items.estValueCents})`;
/** Case-insensitive text key where empty or missing values sort last. */
const textKey = (col: typeof items.player | typeof items.title) => sql`nullif(trim(${col}), '')`;

function orderBy(sort: InventorySort): SQL[] {
  const tie = desc(items.id);
  switch (sort) {
    case "oldest": return [asc(items.createdAt), asc(items.id)];
    case "value_desc": return [sql`${value} is null`, desc(value), tie];
    case "value_asc": return [sql`${value} is null`, asc(value), tie];
    case "year_asc": return [sql`${items.year} is null`, asc(items.year), tie];
    case "year_desc": return [sql`${items.year} is null`, desc(items.year), tie];
    case "player": return [sql`${textKey(items.player)} is null`, sql`lower(${textKey(items.player)})`, tie];
    case "title": return [sql`${textKey(items.title)} is null`, sql`lower(${textKey(items.title)})`, tie];
    default: return [desc(items.createdAt), tie];
  }
}

export function listItems(filters: InventoryFilters, db: Db = getDb()): InventoryResult {
  const w = where(filters);
  const t = db.select({
    total: sql<number>`count(*)`,
    units: sql<number>`coalesce(sum(${items.quantity}), 0)`,
    cents: sql<number>`coalesce(sum(coalesce(${items.manualValueCents}, ${items.estValueCents}, 0) * ${items.quantity}), 0)`,
  }).from(items).where(w).get();
  const total = Number(t?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(filters.page, 1), pageCount);
  const rows = db.select().from(items).where(w).orderBy(...orderBy(filters.sort))
    .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE).all();
  return { rows, total, totalUnits: Number(t?.units ?? 0), totalValueCents: Number(t?.cents ?? 0), page, pageCount };
}
