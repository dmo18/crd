import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, notExists, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { GONE_STATUSES, ITEM_KINDS, RARITY_TIERS, SPORTS, STATUS_FILTERS, images, items, type Item } from "@/db/schema";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { duplicateIds } from "./duplicates";
import { liveItem, notDeleted } from "./live";

export const PAGE_SIZE = 40;
export const SORTS = ["newest", "oldest", "value_desc", "value_asc", "year_asc", "year_desc", "player", "title"] as const;
export type InventorySort = (typeof SORTS)[number];
/** Smart filter "missing": items where this is empty. */
export const MISSING_FIELDS = ["player", "year", "brand", "cardNumber", "team", "location", "value", "photo"] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];
/** Smart filter "flag": possible duplicates, or reads below the review line. */
export const ITEM_FLAGS = ["duplicates", "lowConfidence"] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

/** Graded and raw cards, one rule for the Inventory filter and the Home totals. Graded: a grading company is written down. Raw: a card with none. */
export const gradedCond: SQL = sql`nullif(trim(${items.grader}), '') is not null`;
export const rawCond: SQL = and(eq(items.kind, "card"), sql`nullif(trim(${items.grader}), '') is null`)!;
export const GRADINGS = ["graded", "raw"] as const;
/** The yes or no marks a card can have, each its own link parameter set to "1". */
export const MARK_FILTERS = { autograph: items.isAutograph, relic: items.isMemorabilia, error: items.isError, parallel: items.isParallel, insert: items.isInsert } as const;

/** URL params can repeat (arrays). Use the first value. */
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const words = (max: number) => z.preprocess(first, z.string().trim().min(1).max(max)).optional().catch(undefined);
const dollarsText = z.preprocess(first, z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/).transform(Number)).optional().catch(undefined);
const one = z.preprocess(first, z.literal("1").transform(() => true as const)).optional().catch(undefined);
const intText = (min: number, max: number) =>
  z.preprocess(first, z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(min).max(max)));

/** Parses URL search params. Anything invalid quietly counts as "not set". */
export const inventoryFilterSchema = z.object({
  q: z.preprocess(first, z.string().trim().max(100).transform((s) => s || undefined)).optional().catch(undefined),
  kind: z.preprocess(first, z.enum(ITEM_KINDS)).optional().catch(undefined),
  sport: z.preprocess(first, z.enum(SPORTS)).optional().catch(undefined),
  status: z.preprocess(first, z.enum(STATUS_FILTERS)).optional().catch(undefined),
  /** One tier or a comma list such as "key,grail". Unknown names make the whole filter "not set". */
  tier: z.preprocess(
    (v) => {
      const one = first(v);
      return typeof one === "string" ? one.split(",").map((t) => t.trim()).filter(Boolean) : one;
    },
    z.array(z.enum(RARITY_TIERS)).min(1).max(RARITY_TIERS.length)
      .transform((list) => RARITY_TIERS.filter((t) => list.includes(t))),
  ).optional().catch(undefined),
  rookie: z.preprocess(first, z.literal("1").transform(() => true as const)).optional().catch(undefined),
  yearFrom: intText(1860, 2100).optional().catch(undefined),
  yearTo: intText(1860, 2100).optional().catch(undefined),
  location: z.preprocess(first, z.union([z.literal("none"), intText(1, 2_000_000_000)])).optional().catch(undefined),
  value: z.preprocess(first, z.literal("none")).optional().catch(undefined),
  missing: z.preprocess(first, z.enum(MISSING_FIELDS)).optional().catch(undefined),
  flag: z.preprocess(first, z.enum(ITEM_FLAGS)).optional().catch(undefined),
  /** "Version not sure": cards whose version the owner answered "Not sure yet". */
  version: z.preprocess(first, z.literal("not_sure")).optional().catch(undefined),
  autograph: one,
  relic: one,
  error: one,
  parallel: one,
  insert: one,
  /** Has a print run number such as 045/100. */
  serial: one,
  /** More than one copy in the row. */
  multi: one,
  grading: z.preprocess(first, z.enum(GRADINGS)).optional().catch(undefined),
  grader: words(20),
  grade: words(20),
  /** Part of the version or parallel name, e.g. "Refractor". */
  variation: words(120),
  /** Exact (not case sensitive) player, team and set, used by the Home breakdowns. */
  player: words(120),
  team: words(80),
  set: words(120),
  /** Value of one unit in dollars. Items with no price never match a range. */
  minValue: dollarsText,
  maxValue: dollarsText,
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

const value = sql`coalesce(${items.manualValueCents}, ${items.estValueCents})`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const blank = (col: typeof items.player | typeof items.brand | typeof items.cardNumber | typeof items.team) => or(isNull(col), sql`trim(${col}) = ''`);

function missingCondition(field: MissingField, db: Db): SQL | undefined {
  switch (field) {
    case "player": return blank(items.player);
    case "brand": return blank(items.brand);
    case "cardNumber": return blank(items.cardNumber);
    case "team": return blank(items.team);
    case "year": return isNull(items.year);
    case "location": return isNull(items.locationId);
    case "value": return and(isNull(items.manualValueCents), isNull(items.estValueCents));
    case "photo": return notExists(db.select({ one: sql`1` }).from(images).where(eq(images.itemId, items.id)));
  }
}

function flagCondition(flag: ItemFlag, db: Db): SQL | undefined {
  if (flag === "lowConfidence") return lt(items.confidence, REVIEW_THRESHOLD);
  // The ids go in as one JSON value (a bound parameter), so any number of them fits.
  const ids = duplicateIds(db);
  return sql`${items.id} in (select value from json_each(${JSON.stringify(ids)}))`;
}

/** Same text, ignoring capitals and outer spaces. */
const sameText = (col: SQLWrapper, v: string) => sql`lower(trim(${col})) = ${v.trim().toLowerCase()}`;

/** Names of every filter in the link (all but sort and page), for "is anything filtered?" checks. */
export const FILTER_PARAM_KEYS = Object.keys(inventoryFilterSchema.shape).filter((k) => k !== "sort" && k !== "page");

/** Filters set, not counting the search words: what the "Filters" button counts. */
export function countFilters(f: InventoryFilters): number {
  return FILTER_PARAM_KEYS.filter((k) => k !== "q" && f[k as keyof InventoryFilters] !== undefined).length;
}

function where(f: InventoryFilters, db: Db): SQL | undefined {
  // Sold and removed items show only when asked for; they are in no other list.
  const gone = f.status === "sold" || f.status === "removed" || f.status === "gone";
  const conds: (SQL | undefined)[] = [gone ? notDeleted : liveItem];
  const words = (f.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const pattern = `%${escapeLike(w)}%`;
    conds.push(or(...SEARCH_COLUMNS.map((c) => sql`${c} like ${pattern} escape '\\'`)));
  }
  if (f.kind) conds.push(eq(items.kind, f.kind));
  if (f.sport) conds.push(eq(items.sport, f.sport));
  if (f.status === "gone") conds.push(inArray(items.status, [...GONE_STATUSES]));
  else if (f.status) conds.push(eq(items.status, f.status));
  for (const [k, col] of Object.entries(MARK_FILTERS)) if (f[k as keyof typeof MARK_FILTERS]) conds.push(eq(col, true));
  if (f.serial) conds.push(sql`nullif(trim(${items.serialNumber}), '') is not null`);
  if (f.multi) conds.push(sql`${items.quantity} > 1`);
  if (f.grading === "graded") conds.push(gradedCond);
  if (f.grading === "raw") conds.push(rawCond);
  if (f.grader) conds.push(sameText(items.grader, f.grader));
  if (f.grade) conds.push(sameText(items.grade, f.grade));
  if (f.variation) conds.push(sql`${items.variation} like ${`%${escapeLike(f.variation)}%`} escape '\\'`);
  if (f.player) conds.push(sameText(items.player, f.player));
  if (f.team) conds.push(sameText(items.team, f.team));
  if (f.set) conds.push(sameText(items.setName, f.set));
  if (f.minValue != null) conds.push(sql`${value} >= ${Math.round(f.minValue * 100)}`);
  if (f.maxValue != null) conds.push(sql`${value} <= ${Math.round(f.maxValue * 100)}`);
  if (f.tier?.length) conds.push(inArray(items.rarityTier, f.tier));
  if (f.rookie) conds.push(eq(items.isRookie, true));
  if (f.yearFrom != null) conds.push(gte(items.year, f.yearFrom));
  if (f.yearTo != null) conds.push(lte(items.year, f.yearTo));
  if (f.location === "none") conds.push(isNull(items.locationId));
  else if (f.location != null) conds.push(eq(items.locationId, f.location));
  if (f.value === "none") conds.push(and(isNull(items.manualValueCents), isNull(items.estValueCents)));
  if (f.missing) conds.push(missingCondition(f.missing, db));
  if (f.flag) conds.push(flagCondition(f.flag, db));
  if (f.version) conds.push(eq(items.versionState, "not_sure"));
  return and(...conds);
}

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
  const w = where(filters, db);
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

/**
 * The ids of live items matching the filters (page and sort ignored), at most
 * `cap` of them, lowest id first, and how many match in all. Used by bulk
 * changes to run "all N matching" again on the server.
 */
export function matchingIds(filters: Omit<InventoryFilters, "page" | "sort">, cap: number, db: Db = getDb()): { ids: number[]; total: number } {
  const w = where({ ...filters, sort: "newest", page: 1 }, db);
  const total = Number(db.select({ n: sql<number>`count(*)` }).from(items).where(w).get()?.n ?? 0);
  const ids = db.select({ id: items.id }).from(items).where(w).orderBy(asc(items.id)).limit(Math.max(0, cap)).all().map((r) => r.id);
  return { ids, total };
}
