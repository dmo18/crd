import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { CATALOG_FIELDS, catalogCards, items, type CatalogCardRow, type CatalogField, type Item } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { buildTitle } from "@/lib/title";
import { isFilled, parseFieldSources, sourceOf, type FieldSources } from "./sources";

/** The part of a catalog card the filling rule needs. */
export type CatalogValues = Pick<CatalogCardRow, "id" | CatalogField>;
/** A field the scanner read differently from the catalog. Shown under the pick. */
export type CatalogDifference = { field: CatalogField; itemValue: string | number; catalogValue: string | number };
export type ApplyResult = {
  /** Columns to write on the item. Never `firstSuggestion`, never a value column. */
  patch: Partial<Item>;
  /** Fields that were empty and are now filled from the catalog. */
  filled: CatalogField[];
  /** Fields the scanner read that were replaced by the catalog's value (only with `useCatalogValues`). */
  replaced: CatalogField[];
  /** Fields the scanner read that still differ from the catalog. */
  differences: CatalogDifference[];
};

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;

/**
 * The filling rule, used everywhere a catalog card meets an item:
 * 1. Empty fields are filled and marked `catalog`.
 * 2. A field marked `owner` (or not marked at all, as on old items) is never changed.
 * 3. A field marked `reading` that differs from the catalog is not changed,
 *    only listed, unless `useCatalogValues` is set ("Use the catalog's
 *    values"), which changes those `reading` fields and nothing else.
 * 4. The title is rebuilt; values and `firstSuggestion` are not touched.
 * Fields from the key card list or Wikidata are kept as they are. An empty
 * catalog field never empties an item field. Pure: writes nothing.
 */
export function applyCatalogCard(item: Item, card: CatalogValues, opts: { useCatalogValues?: boolean } = {}): ApplyResult {
  const marks: FieldSources = parseFieldSources(item.fieldSources) ?? {};
  const before = JSON.stringify(marks);
  const values: Partial<Record<CatalogField, unknown>> = {};
  const filled: CatalogField[] = [];
  const replaced: CatalogField[] = [];
  const differences: CatalogDifference[] = [];
  for (const f of CATALOG_FIELDS) {
    const theirs = card[f];
    if (!isFilled(theirs)) continue;
    const source = sourceOf(item, f, marks);
    if (source === null) {
      values[f] = theirs;
      marks[f] = "catalog";
      filled.push(f);
    } else if (source === "reading" && !same(item[f], theirs)) {
      if (opts.useCatalogValues) {
        values[f] = theirs;
        marks[f] = "catalog";
        replaced.push(f);
      } else {
        differences.push({ field: f, itemValue: item[f] as string | number, catalogValue: theirs as string | number });
      }
    }
  }
  const patch: Partial<Item> = { ...(values as Partial<Item>) };
  if (item.catalogCardId !== card.id) patch.catalogCardId = card.id;
  const after = JSON.stringify(marks);
  // An old item without marks keeps none unless a field was filled: unmarked already means `owner`.
  if (after !== before) patch.fieldSources = after;
  const title = buildTitle({ ...item, ...patch });
  if (title !== item.title) patch.title = title;
  return { patch, filled, replaced, differences };
}

export type LinkResult = { ok: true; differences: CatalogDifference[] } | { ok: false; error: string };

/** Links a confirmed catalog card to an item by the filling rule. Adds no value row and leaves the status alone. */
export function linkCatalogCard(
  itemId: number, catalogCardId: number, db: Db = getDb(), opts: { useCatalogValues?: boolean; now?: Date } = {},
): LinkResult {
  return db.transaction((tx) => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: "This item no longer exists." };
    if (item.kind !== "card") return { ok: false, error: "Only a single card can be linked to a catalog card." };
    const card = tx.select().from(catalogCards).where(eq(catalogCards.id, catalogCardId)).get();
    if (!card) return { ok: false, error: "That catalog card no longer exists." };
    const { patch, differences } = applyCatalogCard(item, card, opts);
    if (Object.keys(patch).length > 0) {
      tx.update(items).set({ ...patch, updatedAt: opts.now ?? new Date() }).where(and(eq(items.id, itemId), liveItem)).run();
    }
    return { ok: true, differences };
  }, { behavior: "immediate" });
}

/**
 * Unlinks: sets the catalog link to null and keeps every value. The fields
 * the catalog filled are marked `reading` from then on, so a later link to
 * another card lists or replaces them under the normal rules instead of
 * treating them as empty or as the owner's.
 */
export function unlinkCatalogCard(itemId: number, db: Db = getDb()): { ok: boolean } {
  return db.transaction((tx) => {
    const item = tx.select({ id: items.id, fieldSources: items.fieldSources }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false };
    const patch: Partial<Item> = { catalogCardId: null };
    const marks = parseFieldSources(item.fieldSources);
    if (marks) {
      let changed = false;
      for (const f of CATALOG_FIELDS) if (marks[f] === "catalog") { marks[f] = "reading"; changed = true; }
      if (changed) patch.fieldSources = JSON.stringify(marks);
    }
    const res = tx.update(items).set(patch).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: res.changes > 0 };
  }, { behavior: "immediate" });
}
