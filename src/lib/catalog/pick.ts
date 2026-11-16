import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { catalogCards, catalogSources, type CatalogField, type Item, items } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { applyCatalogCard, type CatalogDifference } from "./apply";
import { candidateCard, parseCatalog, serializeCatalog, type NotCheckedReason } from "./candidates";
import { sourceUrl } from "./clean";
import { cardLine } from "./line";
import { lookupCard } from "./lookup";
import { getCatalog } from "./provider";
import { saveCatalogCardIn } from "./store";
import type { Catalog, CatalogCard } from "./types";

/**
 * The catalog in Review: a sure card from a scan is applied when the item is
 * filed; candidates wait for the owner's one tap ("This one"). Every rule
 * goes through `applyCatalogCard` (the filling rule), so an `owner` field is
 * never changed and a `reading` field only through "Use the catalog's values".
 */

const GONE = "This item no longer exists.";
const NOT_A_CARD = "Only a single card can be linked to a catalog card.";
export const ALREADY_LINKED = "This item is already linked. Unlink it first.";
export const NOT_ON_LIST = "That choice is no longer on the list. Look at the list again.";
export const LOOKUP_WAIT = "Wait a few seconds before looking this card up again.";
export const LOOKUP_NEEDS = "Add a player or a card number first, then look it up again.";

/**
 * Files a sure catalog card on an item a scan just made, inside the scan's
 * transaction: the card is kept, the item linked, empty fields filled and
 * marked `catalog`, and the confidence set as the matching rule says.
 * Returns false (and changes nothing) when the card cannot be kept; the
 * caller then keeps it as a candidate.
 */
export function applyScanCard(tx: Db, item: Item, card: CatalogCard, confidence: number, now: Date): boolean {
  const saved = saveCatalogCardIn(tx, card, now);
  if (!saved.ok) return false;
  const row = tx.select().from(catalogCards).where(eq(catalogCards.id, saved.catalogCardId)).get();
  if (!row) return false;
  const { patch } = applyCatalogCard(item, row);
  tx.update(items).set({
    ...patch, confidence, status: confidence >= REVIEW_THRESHOLD ? "confirmed" : "needs_review", catalogCandidates: null, updatedAt: now,
  }).where(eq(items.id, item.id)).run();
  return true;
}

export type PickResult =
  | { ok: true; line: string; differences: CatalogDifference[]; confirmed: boolean }
  | { ok: false; error: string };

/**
 * "This one": the owner picked the candidate at `position` of the list the
 * server stored on the item (never fields sent by the browser). Links the
 * card by the filling rule and clears the list. With no differences the item
 * is confirmed and leaves Review; with differences it stays so the owner can
 * choose "Use the catalog's values" or keep the scanner's.
 */
export function pickCandidate(itemId: number, position: number, db: Db = getDb(), now: Date = new Date()): PickResult {
  return db.transaction((tx): PickResult => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: GONE };
    if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
    if (item.catalogCardId != null) return { ok: false, error: ALREADY_LINKED };
    const stored = parseCatalog(item.catalogCandidates, now);
    const chosen = stored?.status === "candidates" && Number.isInteger(position) && position >= 0 ? stored.items[position] : undefined;
    if (!chosen) return { ok: false, error: NOT_ON_LIST };
    const card = candidateCard(chosen);
    const saved = saveCatalogCardIn(tx as unknown as Db, card, now);
    if (!saved.ok) return { ok: false, error: saved.error };
    const row = tx.select().from(catalogCards).where(eq(catalogCards.id, saved.catalogCardId)).get()!;
    const { patch, differences } = applyCatalogCard(item, row);
    const confirmed = differences.length === 0;
    tx.update(items).set({
      ...patch, catalogCandidates: null, ...(confirmed ? { status: "confirmed" as const } : {}), updatedAt: now,
    }).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: true, line: cardLine(row), differences, confirmed };
  }, { behavior: "immediate" });
}

/**
 * "Use the catalog's values": the item's own linked card replaces the fields
 * the scanner read differently. `owner` fields stay. With `confirm` (Review)
 * the item is confirmed too.
 */
export function takeCatalogValues(itemId: number, opts: { confirm?: boolean; now?: Date } = {}, db: Db = getDb()): { ok: true; replaced: CatalogField[] } | { ok: false; error: string } {
  const now = opts.now ?? new Date();
  return db.transaction((tx) => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: GONE } as const;
    if (item.catalogCardId == null) return { ok: false, error: "This item is not linked to a catalog card." } as const;
    const row = tx.select().from(catalogCards).where(eq(catalogCards.id, item.catalogCardId)).get();
    if (!row) return { ok: false, error: "That catalog card no longer exists." } as const;
    const { patch, replaced } = applyCatalogCard(item, row, { useCatalogValues: true });
    tx.update(items).set({
      ...patch, ...(opts.confirm ? { status: "confirmed" as const, catalogCandidates: null } : {}), updatedAt: now,
    }).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: true, replaced } as const;
  }, { behavior: "immediate" });
}

/** "None of these": the list is cleared; the item stays in Review with its reading. */
export function dismissCandidates(itemId: number, db: Db = getDb()): { ok: boolean } {
  const res = db.update(items).set({ catalogCandidates: null }).where(and(eq(items.id, itemId), liveItem)).run();
  return { ok: res.changes > 0 };
}

// "Look up again": once per 10 seconds per item, remembered next to the database.
export const LOOKUP_EVERY_MS = 10_000;
const holder = globalThis as unknown as { __crdLookups?: Map<number, number> };
function lastLookups(): Map<number, number> {
  holder.__crdLookups ??= new Map();
  return holder.__crdLookups;
}
/** Tests start clean. */
export function resetLookupLimitForTests(): void {
  lastLookups().clear();
}

export type LookupAgainResult =
  | { ok: true; found: number; notChecked: NotCheckedReason | null }
  | { ok: false; error: string };

/**
 * "Look up again" with the item's fields of the moment, in the `now` line.
 * What comes back is stored as the item's candidates for one tap, a sure
 * card first; nothing is filled in until the owner picks.
 */
export async function lookUpAgain(itemId: number, deps: { db?: Db; catalog?: Catalog; now?: () => Date } = {}): Promise<LookupAgainResult> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? (() => new Date());
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: GONE };
  if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
  if (item.catalogCardId != null) return { ok: false, error: ALREADY_LINKED };
  if (!item.player?.trim() && !item.cardNumber?.trim()) return { ok: false, error: LOOKUP_NEEDS };
  const seen = lastLookups();
  const t = now().getTime();
  const last = seen.get(itemId);
  if (last !== undefined && t - last < LOOKUP_EVERY_MS) return { ok: false, error: LOOKUP_WAIT };
  seen.set(itemId, t);
  if (seen.size > 1000) for (const [k, v] of seen) if (t - v >= LOOKUP_EVERY_MS) seen.delete(k);

  let stored: string;
  let found = 0;
  let notChecked: NotCheckedReason | null = null;
  try {
    const r = await lookupCard({
      year: item.year, brands: item.brand ? [item.brand] : [], sport: item.sport,
      names: item.player ? [item.player] : [], cardNumber: item.cardNumber,
    }, "now", { catalog: deps.catalog ?? getCatalog() });
    const list = r.sure ? [r.sure, ...r.candidates.filter((c) => c.sourceId !== r.sure!.sourceId)] : r.candidates;
    found = list.length;
    if (found > 0) stored = serializeCatalog({ status: "candidates", items: list }, now());
    else if (r.stopped) {
      notChecked = r.stopped;
      stored = serializeCatalog({ status: "not_checked", reason: r.stopped }, now());
    } else stored = serializeCatalog({ status: "none" }, now());
  } catch {
    notChecked = "failed";
    stored = serializeCatalog({ status: "not_checked", reason: "failed" }, now());
  }
  const res = db.update(items).set({ catalogCandidates: stored })
    .where(and(eq(items.id, itemId), liveItem)).run();
  if (res.changes === 0) return { ok: false, error: GONE };
  return { ok: true, found, notChecked };
}

/** What Review shows for one item: the catalog's part, in plain data for the screen. */
export type ReviewCatalogView = {
  /** Linked card line and the fields the scanner read differently. */
  linked: { line: string; url: string | null; differences: { label: string; read: string; catalog: string }[] } | null;
  status: "candidates" | "none" | "not_checked" | null;
  reason: NotCheckedReason | null;
  candidates: { position: number; line: string; verified: boolean; url: string | null }[];
  /** "Look up again" is offered: a card with a player or a number and no link. */
  canLookUp: boolean;
};

export const FIELD_WORDS: Record<CatalogField, string> = {
  sport: "sport", year: "year", brand: "brand", setName: "set", cardNumber: "number", player: "player", team: "team", variation: "variation",
};

export function reviewCatalogView(item: Item, db: Db = getDb(), now: Date = new Date()): ReviewCatalogView | null {
  if (item.kind !== "card") return null;
  let linked: ReviewCatalogView["linked"] = null;
  if (item.catalogCardId != null) {
    const row = db.select().from(catalogCards).where(eq(catalogCards.id, item.catalogCardId)).get();
    if (row) {
      const src = db.select({ url: catalogSources.url }).from(catalogSources).where(eq(catalogSources.catalogCardId, row.id)).get();
      const { differences } = applyCatalogCard(item, row);
      linked = {
        line: cardLine(row), url: sourceUrl(src?.url),
        differences: differences.map((d) => ({ label: FIELD_WORDS[d.field], read: String(d.itemValue), catalog: String(d.catalogValue) })),
      };
    }
  }
  const stored = item.catalogCardId == null ? parseCatalog(item.catalogCandidates, now) : null;
  return {
    linked,
    status: stored?.status ?? null,
    reason: stored?.reason ?? null,
    candidates: (stored?.items ?? []).map((c, position) => ({ position, line: cardLine(c), verified: c.verified, url: sourceUrl(c.url) })),
    canLookUp: item.catalogCardId == null && Boolean(item.player?.trim() || item.cardNumber?.trim()),
  };
}
