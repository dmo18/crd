import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { catalogCards, catalogSources, items, type NewItem } from "@/db/schema";
import { buildTitle } from "@/lib/title";
import { canonicalKey } from "./key";
import { sourcesFor } from "./sources";
import type { CatalogCard } from "./types";

/**
 * Keeping a catalog card for good. Only the card the owner confirmed is
 * written (the storage policy): this runs after the owner tapped Add or
 * "This is my card", never for a card that was only looked at.
 */

export type SaveCardResult = { ok: true; catalogCardId: number } | { ok: false; error: string };

/** Why a card cannot become a catalog card: sport, year, brand and player are needed. */
export const NOT_ENOUGH_FACTS = "This listing is missing facts the catalog needs (sport, year, brand and player). Add the card by hand instead.";

/**
 * Stores the card and its source row once. The same source id or the same
 * canonical key gives back the row that is already there.
 */
export function saveCatalogCard(card: CatalogCard, db: Db = getDb(), now: Date = new Date()): SaveCardResult {
  return db.transaction((tx) => saveCatalogCardIn(tx as unknown as Db, card, now), { behavior: "immediate" });
}

/** The same, for a caller that is already inside a transaction (`tx`). Opens no transaction of its own. */
export function saveCatalogCardIn(tx: Db, card: CatalogCard, now: Date = new Date()): SaveCardResult {
  const key = canonicalKey(card);
  const { sport, year, brand, player } = card;
  if (!key || !sport || year == null || !brand || !player) return { ok: false, error: NOT_ENOUGH_FACTS };
  {
    const known = tx.select({ id: catalogSources.catalogCardId }).from(catalogSources)
      .where(and(eq(catalogSources.source, card.source), eq(catalogSources.sourceId, card.sourceId))).get();
    if (known) return { ok: true, catalogCardId: known.id } as const;
    let row = tx.select({ id: catalogCards.id }).from(catalogCards).where(eq(catalogCards.canonicalKey, key)).get();
    if (!row) {
      const values = {
        sport, year, brand, setName: card.setName, cardNumber: card.cardNumber,
        player, team: null, variation: card.variation,
      };
      row = tx.insert(catalogCards).values({
        canonicalKey: key, ...values, verified: card.verified, fieldSources: sourcesFor(values, "catalog"),
        createdAt: now, updatedAt: now,
      }).returning({ id: catalogCards.id }).get();
    }
    tx.insert(catalogSources).values({
      catalogCardId: row.id, source: card.source, sourceId: card.sourceId, url: card.url,
      sourceSetId: card.sourceSetId, fetchedAt: now,
    }).run();
    return { ok: true, catalogCardId: row.id } as const;
  }
}

/**
 * "Add to my collection": stores the catalog card (once) and makes a new
 * `card` item from it: confirmed, quantity 1, every filled field marked
 * `catalog`. A second add of the same card makes a second item, not a
 * second catalog card.
 */
export function addCardToCollection(
  card: CatalogCard, db: Db = getDb(), now: Date = new Date(),
): { ok: true; itemId: number; catalogCardId: number } | { ok: false; error: string } {
  return db.transaction((tx) => {
    const saved = saveCatalogCardIn(tx as unknown as Db, card, now);
    if (!saved.ok) return saved;
    const row = tx.select().from(catalogCards).where(eq(catalogCards.id, saved.catalogCardId)).get()!;
    const fields = {
      sport: row.sport, year: row.year, brand: row.brand, setName: row.setName, cardNumber: row.cardNumber,
      player: row.player, team: row.team, variation: row.variation,
    };
    const values: NewItem = {
      kind: "card", status: "confirmed", title: buildTitle({ kind: "card", ...fields }), ...fields,
      fieldSources: sourcesFor(fields, "catalog"), catalogCardId: row.id, quantity: 1, createdAt: now, updatedAt: now,
    };
    const item = tx.insert(items).values(values).returning({ id: items.id }).get();
    return { ok: true, itemId: item.id, catalogCardId: row.id } as const;
  }, { behavior: "immediate" });
}
