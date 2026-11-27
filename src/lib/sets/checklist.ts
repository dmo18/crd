import { eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { cardSets, catalogCards, catalogSources, checklistEntries, items, type CardSetRow } from "@/db/schema";
import { candidateCard, parseCatalog } from "@/lib/catalog/candidates";
import { setIdFromUrl } from "@/lib/catalog/clean";
import { baseSetIdOf, brandAgrees, buildQueries, isUnverified, productOf, type FindRead } from "@/lib/catalog/find";
import { normalizeBrand, normalizeText } from "@/lib/catalog/normalize";
import { getCatalog } from "@/lib/catalog/provider";
import type { Catalog, CatalogCard, CatalogFailure } from "@/lib/catalog/types";
import { numberKeyOf, parseSetKey, type SetIdentity } from "./identity";
import { ownedCardsOf } from "./view";

/**
 * "Get the checklist" on a set page (Milestone 15). Only when the owner taps
 * it, for that one set, every call through the shared gate (stored answers
 * first, its hourly and daily caps). Steps, each kept so a stopped load goes
 * on from where it stopped:
 * 1. The catalog's set id: stored on the set, else from the owner's own
 *    catalog answers (linked cards, the candidates kept on items), else from
 *    at most 2 searches, the first search a scan makes for an owned card (so a
 *    scan's stored answer is used). The id is picked as S1a rule D picks it.
 * 2. The set's checklist (one call; the source sends at most 500 cards and
 *    cannot page further, so a longer set is stored as incomplete).
 */

export const MAX_SET_SEARCHES = 2;
const SEARCH_LIMIT = 10;
const MAX_TRIES = 2;
const MAX_ENTRIES = 2000;

export type LoadResult =
  | { kind: "loaded"; entries: number; complete: boolean }
  | { kind: "not_in_catalog" }
  | { kind: "stopped"; reason: CatalogFailure; step: "find" | "list" }
  | { kind: "no_set" };

type Spelling = { sport: CardSetRow["sport"]; year: number; brand: string | null; setName: string | null };

/** The set as a reading, for the shared rules of find.ts. */
function readOf(s: Spelling, card?: { cardNumber: string | null; player: string | null }): FindRead {
  return { sport: s.sport, year: s.year, brand: s.brand, setName: s.setName, cardNumber: card?.cardNumber ?? null, player: card?.player ?? null, team: null, unsure: [] };
}

/**
 * The catalog's id of this set from clean answers, or null when none or more
 * than one. The base set (no set name, or one that is a product) is picked by
 * rule D's baseSetIdOf; a named set (such as "Traded") needs the catalog's
 * set name to be that name.
 */
export function setIdFrom(identity: SetIdentity, spelling: Spelling, cards: readonly CatalogCard[]): string | null {
  const read = readOf(spelling);
  const product = productOf(spelling.brand, spelling.setName);
  const setIsProduct = identity.setKey === "" || (product !== null && spelling.setName !== null && normalizeBrand(product) === normalizeBrand(spelling.setName));
  if (setIsProduct) return baseSetIdOf(identity.setKey === "" ? { ...read, setName: null } : read, cards);
  const ids = new Set<string>();
  for (const c of cards) {
    if (!c.verified || isUnverified(c) || c.year !== identity.year || c.variation || !c.sourceSetId) continue;
    if (identity.sport && c.sport !== identity.sport) continue;
    if (setIdFromUrl(c.url) !== c.sourceSetId) continue;
    if (normalizeText(c.setName ?? "") !== identity.setKey) continue;
    if (!brandAgrees({ brand: spelling.brand, setName: null }, c)) continue;
    ids.add(c.sourceSetId);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** Catalog cards the app already holds for the owner's cards of this set: no call. */
function knownCards(itemIds: number[], db: Db): CatalogCard[] {
  if (itemIds.length === 0) return [];
  const out: CatalogCard[] = [];
  const rows = db.select({ catalogCandidates: items.catalogCandidates, catalogCardId: items.catalogCardId }).from(items).where(inArray(items.id, itemIds)).all();
  for (const r of rows) {
    const stored = parseCatalog(r.catalogCandidates, new Date(), { anyAge: true });
    for (const c of stored?.items ?? []) out.push(candidateCard(c));
  }
  // Linked cards: the confirmed catalog card and its source row (url and set id).
  const linkedIds = rows.map((r) => r.catalogCardId).filter((v): v is number => v != null);
  if (linkedIds.length > 0) {
    const linked = db
      .select({ card: catalogCards, src: catalogSources })
      .from(catalogSources)
      .innerJoin(catalogCards, eq(catalogCards.id, catalogSources.catalogCardId))
      .where(inArray(catalogSources.catalogCardId, linkedIds))
      .all();
    for (const { card, src } of linked) {
      if (!src.url || out.some((c) => c.sourceId === src.sourceId)) continue;
      out.push({
        source: "mycardfolio", sourceId: src.sourceId, url: src.url, sourceSetId: src.sourceSetId, verified: card.verified,
        sport: card.sport, year: card.year, brand: card.brand, setName: card.setName, cardNumber: card.cardNumber,
        player: card.player, otherPlayers: [], variation: card.variation, tags: [], team: card.team,
      });
    }
  }
  return out;
}

function upsertSet(key: string, spelling: Spelling, db: Db): CardSetRow {
  const found = db.select().from(cardSets).where(eq(cardSets.key, key)).get();
  if (found) {
    db.update(cardSets).set({ sport: spelling.sport, year: spelling.year, brand: spelling.brand, setName: spelling.setName, updatedAt: new Date() }).where(eq(cardSets.id, found.id)).run();
    return { ...found, ...spelling };
  }
  return db.insert(cardSets).values({ key, sport: spelling.sport, year: spelling.year, brand: spelling.brand, setName: spelling.setName }).returning().get();
}

/** The checklist is complete only when the source says so and no number from 1 to the highest is missing. */
export function looksComplete(entries: readonly { numberKey: string | null }[], sourceComplete: boolean, total: number | null): boolean {
  if (!sourceComplete) return false;
  const keys = new Set(entries.map((e) => e.numberKey).filter((k): k is string => Boolean(k)));
  if (total !== null && keys.size < total) return false;
  const plain = [...keys].filter((k) => /^\d+$/.test(k)).map(Number);
  const highest = plain.length > 0 ? Math.max(...plain) : 0;
  return plain.length >= highest;
}

/** Load (or load again) one set's checklist. Never throws for a catalog failure. */
export async function loadChecklist(key: string, opts: { db?: Db; catalog?: Catalog; now?: Date } = {}): Promise<LoadResult> {
  const db = opts.db ?? getDb();
  const catalog = opts.catalog ?? getCatalog();
  const now = opts.now ?? new Date();
  const identity = parseSetKey(key);
  const owned = identity ? ownedCardsOf(key, db) : null;
  if (!identity || !owned || owned.cards.length === 0) return { kind: "no_set" };
  const set = upsertSet(key, owned.spelling, db);
  const stop = (reason: CatalogFailure, step: "find" | "list"): LoadResult => {
    db.update(cardSets).set({ lastStop: reason, lastTryAt: now, updatedAt: now }).where(eq(cardSets.id, set.id)).run();
    return { kind: "stopped", reason, step };
  };
  const notThere = (): LoadResult => {
    db.update(cardSets).set({ notInCatalogAt: now, lastStop: null, lastTryAt: now, updatedAt: now }).where(eq(cardSets.id, set.id)).run();
    return { kind: "not_in_catalog" };
  };

  // 1. The set id.
  let setId = set.sourceSetId;
  if (!setId) {
    const seen = knownCards(owned.cards.map((c) => c.id), db);
    setId = setIdFrom(identity, owned.spelling, seen);
    if (!setId) {
      // Cards with a clean number, the lowest first, a named player first: the searches a scan makes.
      const asks = owned.cards
        .filter((c) => c.numberKey && /\d/.test(c.numberKey))
        .sort((a, b) => Number(Boolean(b.player)) - Number(Boolean(a.player)) || a.id - b.id);
      const done = new Set<string>();
      for (const c of asks) {
        if (done.size >= MAX_SET_SEARCHES) break;
        const q = buildQueries(readOf(owned.spelling, c))[0];
        if (!q || done.has(q.text.toLowerCase())) continue;
        done.add(q.text.toLowerCase());
        const ask: Parameters<Catalog["search"]>[0] = { text: q.text, limit: SEARCH_LIMIT };
        if (q.sport) ask.sport = q.sport;
        if (q.year != null) ask.year = q.year;
        const got = await catalog.search(ask, "now", { maxTries: MAX_TRIES });
        if (!got.ok) return stop(got.reason, "find");
        for (const card of got.value) if (!seen.some((s) => s.sourceId === card.sourceId)) seen.push(card);
        setId = setIdFrom(identity, owned.spelling, seen);
        if (setId) break;
      }
    }
    if (!setId) return notThere();
    db.update(cardSets).set({ sourceSetId: setId, updatedAt: now }).where(eq(cardSets.id, set.id)).run();
  }

  // 2. The checklist.
  const list = await catalog.checklist(setId, "now", { maxTries: MAX_TRIES });
  if (!list.ok) return stop(list.reason, "list");
  const rows = list.value.cards.filter((c) => c.sourceSetId === setId).slice(0, MAX_ENTRIES);
  if (rows.length === 0) return notThere();
  const entries = rows.map((c, i) => ({
    setId: set.id,
    position: i,
    cardNumber: c.cardNumber,
    numberKey: numberKeyOf(c.cardNumber),
    player: [c.player, ...c.otherPlayers].filter(Boolean).join(" / ").slice(0, 200) || null,
    team: c.team ?? null,
    sourceId: c.sourceId,
    url: c.url,
  }));
  const total = list.value.total ?? null;
  const complete = looksComplete(entries, list.value.complete, total);
  db.transaction((tx) => {
    tx.delete(checklistEntries).where(eq(checklistEntries.setId, set.id)).run();
    for (let i = 0; i < entries.length; i += 200) tx.insert(checklistEntries).values(entries.slice(i, i + 200)).run();
    tx.update(cardSets)
      .set({ checklistAt: now, checklistComplete: complete, checklistTotal: total, notInCatalogAt: null, lastStop: null, lastTryAt: now, updatedAt: now })
      .where(eq(cardSets.id, set.id))
      .run();
  });
  return { kind: "loaded", entries: entries.length, complete };
}
