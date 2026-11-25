import { and, asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { items, type Item } from "@/db/schema";
import { liveItem, notDeleted } from "@/lib/items/live";
import { FILTER_PARAM_KEYS, inventoryFilterSchema, matchingIds } from "@/lib/items/query";

/** Most items ticked one by one that one export link may carry (same as a selection in Manage records). */
export const MAX_EXPORT_IDS = 500;
/** Most items one filtered export may hold: more than any collection here. */
const MAX_EXPORT_ITEMS = 100_000;
const CHUNK = 500;

const idsSchema = z.string().max(MAX_EXPORT_IDS * 17)
  .regex(/^\d{1,15}(,\d{1,15})*$/)
  .transform((s) => [...new Set(s.split(",").map(Number))])
  .pipe(z.array(z.number().int().positive()).min(1).max(MAX_EXPORT_IDS));

/** Filter names the inventory list uses in its link (src/lib/items/query.ts), so a new filter is never left out of an export. */
const FILTER_KEYS = FILTER_PARAM_KEYS;

export type ExportPick = { rows: Item[]; what: "all" | "filtered" | "selected" } | { error: string };

/**
 * The items one export covers, lowest id first, never a deleted one (sold and removed ones only when ticked or when the filters ask for them):
 * - `ids=1,2,3`: exactly the items ticked in Manage records;
 * - inventory filters (the same link parameters as the list): every item they match, on every page;
 * - nothing: the whole collection.
 */
export function exportPick(params: URLSearchParams, db: Db = getDb()): ExportPick {
  const rawIds = params.get("ids");
  if (rawIds !== null) {
    const r = idsSchema.safeParse(rawIds);
    if (!r.success) return { error: `Select between 1 and ${MAX_EXPORT_IDS} items, then export again.` };
    const rows: Item[] = [];
    for (let i = 0; i < r.data.length; i += CHUNK) {
      rows.push(...db.select().from(items).where(and(inArray(items.id, r.data.slice(i, i + CHUNK)), notDeleted)).all());
    }
    return { rows: rows.sort((a, b) => a.id - b.id), what: "selected" };
  }
  const filtered = FILTER_KEYS.some((k) => params.has(k));
  if (!filtered) return { rows: db.select().from(items).where(liveItem).orderBy(asc(items.id)).all(), what: "all" };
  // Sort and page are ignored: matchingIds covers every page.
  const filters = inventoryFilterSchema.parse(Object.fromEntries(params));
  const { ids } = matchingIds(filters, MAX_EXPORT_ITEMS, db);
  const rows: Item[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    rows.push(...db.select().from(items).where(and(inArray(items.id, ids.slice(i, i + CHUNK)), notDeleted)).all());
  }
  return { rows: rows.sort((a, b) => a.id - b.id), what: "filtered" };
}
