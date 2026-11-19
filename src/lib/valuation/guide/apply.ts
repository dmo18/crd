import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, valuations, type Item } from "@/db/schema";
import { storedPlayerFacts } from "@/lib/free/wikidata";
import { liveItem } from "@/lib/items/live";
import { errorKind, log } from "@/lib/log";
import { guidePrice, type GuidePrice } from "./index";

/**
 * Saves the built-in guide price on items. Rules:
 * - The owner's own value (manualValueCents) is never touched, and an item
 *   with one is left alone: the owner's figure is what the item shows.
 * - Only items with no estimate or a guide estimate are written; an older
 *   estimate from another source is kept.
 * - A guide value that no longer applies (fields changed, now too unclear)
 *   is cleared, so a stale figure never stays.
 * - A history row is added only when the figure changes, so running it
 *   twice changes nothing (safe at every start).
 */

export type GuideResult = { ok: true; changed: boolean; price: GuidePrice } | { ok: false; error: string };

export const GUIDE_MESSAGES = {
  missing: "This item no longer exists.",
  ownValue: "Your own value is kept. Clear it in Edit details to see the guide price.",
  otherSource: "This item already has an estimate from another source.",
} as const;

/** The guide price for an item, using the stored Wikidata Hall of Fame fact when there is one. */
export function guideFor(item: Item, db: Db, now: Date): GuidePrice {
  const facts = item.kind === "card" && item.player
    ? storedPlayerFacts(item.player, { sport: item.sport, year: item.year, db, now })
    : null;
  return guidePrice(item, { hallOfFame: facts ? facts.hallOfFame : null });
}

function writable(item: Item): boolean {
  return item.manualValueCents == null && (item.valueSource == null || item.valueSource === "price_guide");
}

function save(db: Db, item: Item, now: Date): GuideResult {
  const price = guideFor(item, db, now);
  if (!price.ok) {
    if (item.valueSource !== "price_guide") return { ok: true, changed: false, price };
    db.update(items).set({
      estLowCents: null, estHighCents: null, estValueCents: null, valueSource: null, valueBasis: null, valuedAt: null,
    }).where(and(eq(items.id, item.id), liveItem)).run();
    return { ok: true, changed: true, price };
  }
  const same = item.valueSource === "price_guide" && item.estLowCents === price.lowCents
    && item.estHighCents === price.highCents && item.estValueCents === price.valueCents && item.valueBasis === price.basis;
  if (same) return { ok: true, changed: false, price };
  db.transaction((tx) => {
    tx.update(items).set({
      estLowCents: price.lowCents, estHighCents: price.highCents, estValueCents: price.valueCents,
      valueSource: "price_guide", valueBasis: price.basis, valuedAt: now,
    }).where(and(eq(items.id, item.id), liveItem)).run();
    if (item.estValueCents !== price.valueCents || item.valueSource !== "price_guide") {
      tx.insert(valuations).values({
        itemId: item.id, source: "price_guide", lowCents: price.lowCents, highCents: price.highCents,
        valueCents: price.valueCents, basis: price.basis, createdAt: now,
      }).run();
    }
  });
  return { ok: true, changed: true, price };
}

/** Works out and saves the guide price for one item ("Refresh guide price"). */
export function refreshGuidePrice(itemId: number, db: Db = getDb(), now: Date = new Date()): GuideResult {
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: GUIDE_MESSAGES.missing };
  if (item.manualValueCents != null) return { ok: false, error: GUIDE_MESSAGES.ownValue };
  if (!writable(item)) return { ok: false, error: GUIDE_MESSAGES.otherSource };
  return save(db, item, now);
}

/** The same, for use after a save elsewhere: never throws, never fails the caller. */
export function refreshGuideQuietly(itemIds: number | number[], db: Db = getDb(), now: Date = new Date()): void {
  for (const id of Array.isArray(itemIds) ? itemIds : [itemIds]) {
    try {
      refreshGuidePrice(id, db, now);
    } catch (err) {
      log.warn("guide_price_failed", { itemId: id, error: errorKind(err) });
    }
  }
}

/**
 * Fills (and keeps up to date) the guide price on every item that has no
 * value of the owner's and no estimate from another source. Idempotent.
 * Returns how many items changed.
 */
export function fillGuidePrices(db: Db = getDb(), now: Date = new Date()): number {
  const rows = db.select().from(items)
    .where(and(liveItem, isNull(items.manualValueCents), or(isNull(items.valueSource), eq(items.valueSource, "price_guide"))))
    .all();
  let changed = 0;
  for (const row of rows) {
    try {
      const r = save(db, row, now);
      if (r.ok && r.changed) changed += 1;
    } catch (err) {
      log.warn("guide_price_failed", { itemId: row.id, error: errorKind(err) });
    }
  }
  return changed;
}
