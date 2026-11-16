import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, valuations, type Item } from "@/db/schema";
import { liveItem } from "./live";
import { removeItemRows } from "./remove";

const norm = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" ? null : t;
};

/** The fields that make two items "the same thing", normalized for comparison. */
function keyFor(item: Item): string[] | null {
  if (item.kind === "card") {
    const hasWho = norm(item.player) !== null || norm(item.cardNumber) !== null;
    const hasWhen = item.year != null || norm(item.brand) !== null;
    if (!hasWho || !hasWhen) return null;
    return [item.year, item.brand, item.setName, item.cardNumber, item.player, item.variation, item.grader, item.grade]
      .map((v) => (v == null ? "" : norm(String(v)) ?? ""));
  }
  if (item.kind === "sealed") {
    const hasWhen = item.year != null || norm(item.brand) !== null;
    const hasWhat = norm(item.productType) !== null || norm(item.setName) !== null;
    if (!hasWhen || !hasWhat) return null;
    return [item.year, item.brand, item.setName, item.sport, item.productType]
      .map((v) => (v == null ? "" : norm(String(v)) ?? ""));
  }
  return null;
}

/** Other confirmed items that are the same card (or sealed product) as this one. */
export function findDuplicates(itemId: number, db: Db = getDb()): Item[] {
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return [];
  const key = keyFor(item);
  if (!key) return [];
  const candidates = db.select().from(items)
    .where(and(
      liveItem,
      eq(items.kind, item.kind),
      eq(items.status, "confirmed"),
      ne(items.id, item.id),
      item.year == null ? isNull(items.year) : eq(items.year, item.year),
    ))
    .orderBy(asc(items.id)).all();
  return candidates.filter((c) => {
    const k = keyFor(c);
    return k !== null && k.every((v, i) => v === key[i]);
  });
}

/**
 * Ids of live items that have at least one possible duplicate, by the same
 * rule as findDuplicates: another confirmed item of the same kind and key.
 * For the "Possible duplicates" filter. Lowest id first.
 */
export function duplicateIds(db: Db = getDb()): number[] {
  const rows = db.select().from(items).where(and(liveItem, inArray(items.kind, ["card", "sealed"]))).all();
  const groups = new Map<string, { id: number; confirmed: boolean }[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const k = JSON.stringify([row.kind, ...key]);
    const list = groups.get(k) ?? [];
    list.push({ id: row.id, confirmed: row.status === "confirmed" });
    groups.set(k, list);
  }
  const out: number[] = [];
  for (const list of groups.values()) {
    const confirmed = list.filter((x) => x.confirmed).length;
    for (const x of list) if (confirmed - (x.confirmed ? 1 : 0) > 0) out.push(x.id);
  }
  return out.sort((a, b) => a - b);
}

export const MERGE_PROBLEMS = ["not_same", "gone", "too_many"] as const;
export type MergeProblem = (typeof MERGE_PROBLEMS)[number];
export type MergeResult = { ok: true; targetId: number; files: string[] } | { ok: false; error: string; problem: MergeProblem };

/** Largest quantity the item form accepts; a merge never goes above it. */
export const MAX_QUANTITY = 100_000;

export const MERGE_MESSAGES: Record<MergeProblem, string> = {
  not_same: "These are not the same card.",
  gone: "That item no longer exists.",
  too_many: `Together these come to more than ${MAX_QUANTITY.toLocaleString("en-US")}, the most one item can hold. Change the quantity by hand instead.`,
};

const refuse = (problem: MergeProblem) => ({ ok: false, error: MERGE_MESSAGES[problem], problem }) as const;

/** Value fields copied from the source when the target has no value of its own. */
const VALUE_FIELDS = ["estLowCents", "estHighCents", "estValueCents", "valueSource", "valueBasis", "valuedAt", "manualValueCents"] as const;

/**
 * Fold the source into the target: quantities add up and the source is
 * removed. When the target has no value at all, it takes the source's value
 * and value history, so nothing the owner already knew is lost.
 */
export function mergeInto(sourceId: number, targetId: number, db: Db = getDb()): MergeResult {
  if (sourceId === targetId) return refuse("not_same");
  return db.transaction((tx): MergeResult => {
    // An item in Recently deleted cannot take part in a merge.
    const source = tx.select().from(items).where(and(eq(items.id, sourceId), liveItem)).get();
    const target = tx.select().from(items).where(and(eq(items.id, targetId), liveItem)).get();
    if (!source || !target) return refuse("gone");
    if (!findDuplicates(sourceId, tx as unknown as Db).some((d) => d.id === targetId)) return refuse("not_same");
    const quantity = target.quantity + source.quantity;
    if (quantity > MAX_QUANTITY) return refuse("too_many");

    const patch: Partial<Item> = { quantity, updatedAt: new Date() };
    const targetHasValue = target.manualValueCents != null || target.estValueCents != null;
    const sourceHasValue = source.manualValueCents != null || source.estValueCents != null;
    const takeValue = !targetHasValue && sourceHasValue;
    if (takeValue) {
      for (const key of VALUE_FIELDS) (patch as Record<string, unknown>)[key] = source[key];
    }
    tx.update(items).set(patch).where(eq(items.id, targetId)).run();
    if (takeValue) tx.update(valuations).set({ itemId: targetId }).where(eq(valuations.itemId, sourceId)).run();
    // A hard delete on purpose, not the bin: the source's count now lives in
    // the target, so restoring the source would count it twice.
    const files = removeItemRows(tx as unknown as Db, sourceId) ?? [];
    return { ok: true, targetId, files };
  });
}

/** The review queue, oldest first. */
export function reviewItems(limit: number, db: Db = getDb()): Item[] {
  return db.select().from(items).where(and(liveItem, eq(items.status, "needs_review")))
    .orderBy(asc(items.createdAt), asc(items.id)).limit(limit).all();
}

/** How many items are waiting in the review queue. */
export function reviewCount(db: Db = getDb()): number {
  return db.select({ n: count() }).from(items).where(and(liveItem, eq(items.status, "needs_review"))).get()?.n ?? 0;
}
