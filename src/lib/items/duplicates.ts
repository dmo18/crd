import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, valuations, type Item } from "@/db/schema";

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
  const item = db.select().from(items).where(eq(items.id, itemId)).get();
  if (!item) return [];
  const key = keyFor(item);
  if (!key) return [];
  const candidates = db.select().from(items)
    .where(and(
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

export type MergeResult = { ok: true; targetId: number; files: string[] } | { ok: false; error: string };

/** Fold the source into the target: quantities add up and the source is removed. */
export function mergeInto(sourceId: number, targetId: number, db: Db = getDb()): MergeResult {
  if (sourceId === targetId) return { ok: false, error: "These are not the same card." };
  return db.transaction((tx) => {
    const source = tx.select().from(items).where(eq(items.id, sourceId)).get();
    const target = tx.select().from(items).where(eq(items.id, targetId)).get();
    if (!source || !target) return { ok: false, error: "That item no longer exists." } as const;
    if (!findDuplicates(sourceId, tx as unknown as Db).some((d) => d.id === targetId)) {
      return { ok: false, error: "These are not the same card." } as const;
    }
    const files = tx.select({ file: images.file }).from(images).where(eq(images.itemId, sourceId)).all().map((r) => r.file);
    tx.update(items).set({ quantity: target.quantity + source.quantity, updatedAt: new Date() }).where(eq(items.id, targetId)).run();
    tx.delete(images).where(eq(images.itemId, sourceId)).run();
    tx.delete(valuations).where(eq(valuations.itemId, sourceId)).run();
    tx.delete(items).where(eq(items.id, sourceId)).run();
    return { ok: true, targetId, files } as const;
  });
}

/** How many items are waiting in the review queue. */
export function reviewCount(db: Db = getDb()): number {
  return db.select({ n: count() }).from(items).where(eq(items.status, "needs_review")).get()?.n ?? 0;
}
