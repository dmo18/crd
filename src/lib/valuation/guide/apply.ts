import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, valuations, type Item } from "@/db/schema";
import { storedPlayerFacts, type PlayerFacts } from "@/lib/free/wikidata";
import { YEARS_BEFORE } from "./players";
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

/** A card made before the player was about this old cannot be his. */
export const MIN_AGE_ON_CARD = 16;

/**
 * Whether the stored facts can be the card's player by the years: not a card
 * from before he was about 16, nor from before his first seasons.
 */
export function factsFitYear(facts: Pick<PlayerFacts, "birthYear" | "careerStart">, year: number | null): boolean {
  if (year == null) return true;
  if (facts.birthYear != null && year < facts.birthYear + MIN_AGE_ON_CARD) return false;
  if (facts.careerStart != null && year < facts.careerStart - YEARS_BEFORE) return false;
  return true;
}

/** The guide price for an item, using the stored Wikidata Hall of Fame fact when there is one that fits the card's year. */
export function guideFor(item: Item, db: Db, now: Date): GuidePrice {
  const found = item.kind === "card" && item.player
    ? storedPlayerFacts(item.player, { sport: item.sport, year: item.year, db, now })
    : null;
  const facts = found && factsFitYear(found, item.year) ? found : null;
  return guidePrice(item, { hallOfFame: facts ? facts.hallOfFame : null });
}

function writable(item: Item): boolean {
  return item.manualValueCents == null && (item.valueSource == null || item.valueSource === "price_guide");
}

/** Still no owner value and no estimate from another source, checked again in the write itself. */
const stillWritable = and(isNull(items.manualValueCents), or(isNull(items.valueSource), eq(items.valueSource, "price_guide")));

/**
 * Writes the guide figure on one item, from a row read earlier. The write
 * repeats the rule in its own condition, so a value of the owner's or another
 * estimate written meanwhile is never overwritten, and a figure already there
 * is not written twice (so no second history row). Exported for tests.
 */
export function saveGuide(db: Db, item: Item, now: Date): GuideResult {
  const price = guideFor(item, db, now);
  if (!price.ok) {
    if (item.valueSource !== "price_guide") return { ok: true, changed: false, price };
    const res = db.update(items).set({
      estLowCents: null, estHighCents: null, estValueCents: null, valueSource: null, valueBasis: null, valuedAt: null,
    }).where(and(eq(items.id, item.id), liveItem, isNull(items.manualValueCents), eq(items.valueSource, "price_guide"))).run();
    return { ok: true, changed: res.changes > 0, price };
  }
  const same = item.valueSource === "price_guide" && item.estLowCents === price.lowCents
    && item.estHighCents === price.highCents && item.estValueCents === price.valueCents && item.valueBasis === price.basis;
  if (same) return { ok: true, changed: false, price };
  const changed = db.transaction((tx) => {
    const res = tx.update(items).set({
      estLowCents: price.lowCents, estHighCents: price.highCents, estValueCents: price.valueCents,
      valueSource: "price_guide", valueBasis: price.basis, valuedAt: now,
    }).where(and(eq(items.id, item.id), liveItem, stillWritable, notAlready(price))).run();
    if (res.changes === 0) return false;
    if (item.estValueCents !== price.valueCents || item.valueSource !== "price_guide") {
      tx.insert(valuations).values({
        itemId: item.id, source: "price_guide", lowCents: price.lowCents, highCents: price.highCents,
        valueCents: price.valueCents, basis: price.basis, createdAt: now,
      }).run();
    }
    return true;
  });
  return { ok: true, changed, price };
}

/** The row does not hold this very guide figure already. */
function notAlready(price: Extract<GuidePrice, { ok: true }>) {
  return or(
    isNull(items.valueSource), ne(items.valueSource, "price_guide"),
    isNull(items.estLowCents), ne(items.estLowCents, price.lowCents),
    isNull(items.estHighCents), ne(items.estHighCents, price.highCents),
    isNull(items.estValueCents), ne(items.estValueCents, price.valueCents),
    isNull(items.valueBasis), ne(items.valueBasis, price.basis),
  );
}

/** Works out and saves the guide price for one item ("Refresh guide price"). */
export function refreshGuidePrice(itemId: number, db: Db = getDb(), now: Date = new Date()): GuideResult {
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: GUIDE_MESSAGES.missing };
  if (item.manualValueCents != null) return { ok: false, error: GUIDE_MESSAGES.ownValue };
  if (!writable(item)) return { ok: false, error: GUIDE_MESSAGES.otherSource };
  return saveGuide(db, item, now);
}

/** Items handled per transaction (and per statement, well under SQLite's limit on values). */
export const GUIDE_CHUNK = 500;

/**
 * The same for the items a save elsewhere touched (a scan, an import, a bulk
 * change): only those ids, in one transaction per GUIDE_CHUNK items. Never
 * throws, never fails the caller.
 */
export function refreshGuideQuietly(itemIds: number | number[], db: Db = getDb(), now: Date = new Date()): void {
  const ids = [...new Set(Array.isArray(itemIds) ? itemIds : [itemIds])].filter((id) => Number.isSafeInteger(id) && id > 0);
  for (let i = 0; i < ids.length; i += GUIDE_CHUNK) {
    const part = ids.slice(i, i + GUIDE_CHUNK);
    try {
      db.transaction((txRaw) => {
        const tx = txRaw as unknown as Db;
        const rows = tx.select().from(items).where(and(inArray(items.id, part), liveItem, stillWritable)).all();
        for (const row of rows) {
          try {
            tx.transaction((sp) => { saveGuide(sp as unknown as Db, row, now); });
          } catch (err) {
            log.warn("guide_price_failed", { itemId: row.id, error: errorKind(err) });
          }
        }
      }, { behavior: "immediate" });
    } catch (err) {
      log.warn("guide_price_failed", { itemId: part[0], error: errorKind(err) });
    }
  }
}

/**
 * Fills (and keeps up to date) the guide price on every item that has no
 * value of the owner's and no estimate from another source. Idempotent.
 * Returns how many items changed.
 */
export function fillGuidePrices(db: Db = getDb(), now: Date = new Date()): number {
  const rows = db.select().from(items).where(and(liveItem, stillWritable)).all();
  let changed = 0;
  for (const row of rows) {
    try {
      const r = saveGuide(db, row, now);
      if (r.ok && r.changed) changed += 1;
    } catch (err) {
      log.warn("guide_price_failed", { itemId: row.id, error: errorKind(err) });
    }
  }
  return changed;
}
