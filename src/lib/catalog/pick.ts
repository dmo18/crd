import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { catalogCards, catalogSources, type CatalogField, type Item, items } from "@/db/schema";
import { countAuditSince, recordAudit } from "@/lib/audit/store";
import { itemLabel } from "@/lib/audit/subjects";
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
import { normalizeText } from "./normalize";
import { parseFieldSources, sourceOf } from "./sources";
import { buildTitle } from "@/lib/title";
import { catalogVersionName, hasSeveralVersions, isVersionRow } from "./versions";

/**
 * The catalog in Review: candidates wait for the owner's one tap ("This one").
 * Automatic filling of a sure card is OFF (AUTO_FILL_SURE in
 * src/lib/free/recognizer.ts, see PLAN 10.6 fifth review): applyScanCard is
 * kept for a later switch-on but is not reached today. Every rule
 * goes through `applyCatalogCard` (the filling rule), so an `owner` field is
 * never changed and a `reading` field only through "Use the catalog's values".
 */

const GONE = "This item no longer exists.";
const NOT_A_CARD = "Only a single card can be linked to a catalog card.";
export const ALREADY_LINKED = "This item is already linked. Unlink it first.";
export const NOT_ON_LIST = "That choice is no longer on the list. Look at the list again.";
export const LOOKUP_WAIT = "Wait a few seconds before looking this card up again.";
export const LOOKUP_HOURLY = "Too many catalog look ups this hour. Try again later.";
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
  const { patch, differences } = applyCatalogCard(item, row);
  // Confirmed only when the catalog agrees with every field the scanner read;
  // otherwise it waits in Review with the differences and "Use the catalog's values".
  const confirmed = differences.length === 0 && confidence >= REVIEW_THRESHOLD;
  tx.update(items).set({
    ...patch, confidence, status: confirmed ? "confirmed" : "needs_review", catalogCandidates: null, updatedAt: now,
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
export function pickCandidate(itemId: number, position: number, sourceId: string, db: Db = getDb(), now: Date = new Date()): PickResult {
  return db.transaction((tx): PickResult => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: GONE };
    if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
    if (item.catalogCardId != null) return { ok: false, error: ALREADY_LINKED };
    const stored = parseCatalog(item.catalogCandidates, now);
    const chosen = stored?.status === "candidates" && Number.isInteger(position) && position >= 0 ? stored.items[position] : undefined;
    // The list may have changed since the owner looked at it: the card shown must still be at that place.
    if (!chosen || chosen.sourceId !== sourceId) return { ok: false, error: NOT_ON_LIST };
    const card = candidateCard(chosen);
    const saved = saveCatalogCardIn(tx as unknown as Db, card, now);
    if (!saved.ok) return { ok: false, error: saved.error };
    const row = tx.select().from(catalogCards).where(eq(catalogCards.id, saved.catalogCardId)).get()!;
    const applied = applyCatalogCard(item, row);
    const patch: Partial<Item> = { ...applied.patch };
    let differences = applied.differences;
    // The owner tapped that very row: a row that shows a version ("Topps Tiffany") is the owner's choice of
    // that version, but only when the item's variation names it. A base row leaves the version question as it
    // was (PLAN Milestone 11, "A pick in Review"; review fix 3).
    let version: Partial<Item> = {};
    if (isVersionRow(chosen)) {
      const after = { ...item, ...patch } as Item;
      const name = catalogVersionName(after, chosen);
      const have = after.variation?.trim() ? normalizeText(after.variation) : "";
      if (name && have && ` ${have} `.includes(` ${normalizeText(name)} `)) {
        version = { versionState: "confirmed", versionSource: "catalog", versionOptions: null };
      } else if (name && sourceOf(item, "variation") !== "owner") {
        // Empty or only read by the scanner: the owner's tap writes the version name, as chooseVersion does.
        const marks = parseFieldSources(after.fieldSources) ?? {};
        marks.variation = "owner";
        patch.variation = name;
        patch.fieldSources = JSON.stringify(marks);
        patch.title = buildTitle({ ...after, variation: name });
        differences = differences.filter((d) => d.field !== "variation");
        version = { versionState: "confirmed", versionSource: "catalog", versionOptions: null };
      } else if (name) {
        // The owner's own variation says something else: nothing is decided, the difference is shown.
        differences = [...differences.filter((d) => d.field !== "variation"), { field: "variation", itemValue: String(after.variation), catalogValue: name }];
      }
    }
    const confirmed = differences.length === 0;
    tx.update(items).set({
      ...patch, ...version, catalogCandidates: null, ...(confirmed ? { status: "confirmed" as const } : {}), updatedAt: now,
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
export function dismissCandidates(itemId: number, db: Db = getDb(), audit: AuditWho = {}): { ok: boolean } {
  const res = db.update(items).set({ catalogCandidates: null }).where(and(eq(items.id, itemId), liveItem)).run();
  if (res.changes > 0) {
    recordAudit({ event: "catalog_none_of_these", outcome: "ok", ip: audit.ip ?? "unknown", deviceId: audit.deviceId, detail: itemLabel(itemId, db) }, { db });
  }
  return { ok: res.changes > 0 };
}

/** Who did it, for the activity log. */
export type AuditWho = { ip?: string; deviceId?: string | null };

// "Look up again": once per 10 seconds per item, remembered next to the database.
// And 30 an hour for all items together, counted from the activity log (so a restart does not reset it).
export const LOOKUPS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
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
export async function lookUpAgain(itemId: number, deps: { db?: Db; catalog?: Catalog; now?: () => Date; who?: AuditWho } = {}): Promise<LookupAgainResult> {
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
  if (countAuditSince(["catalog_lookup_again"], new Date(t - HOUR_MS), db) >= LOOKUPS_PER_HOUR) return { ok: false, error: LOOKUP_HOURLY };
  seen.set(itemId, t);
  recordAudit({ event: "catalog_lookup_again", outcome: "ok", ip: deps.who?.ip ?? "unknown", deviceId: deps.who?.deviceId, detail: itemLabel(itemId, db) }, { db, now: now() });
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
  // Written only if the item is still live and still unlinked: a card linked meanwhile keeps no list.
  return db.transaction((tx): LookupAgainResult => {
    const res = tx.update(items).set({ catalogCandidates: stored })
      .where(and(eq(items.id, itemId), liveItem, isNull(items.catalogCardId))).run();
    if (res.changes > 0) return { ok: true, found, notChecked };
    const now2 = tx.select({ link: items.catalogCardId }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
    return { ok: false, error: now2 ? ALREADY_LINKED : GONE };
  }, { behavior: "immediate" });
}

/** What Review shows for one item: the catalog's part, in plain data for the screen. */
export type ReviewCatalogView = {
  /** Linked card line and the fields the scanner read differently. */
  linked: { line: string; url: string | null; differences: { label: string; read: string; catalog: string }[] } | null;
  status: "candidates" | "none" | "not_checked" | null;
  reason: NotCheckedReason | null;
  candidates: { position: number; sourceId: string; line: string; verified: boolean; url: string | null }[];
  /** "Look up again" is offered: a card with a player or a number and no link. */
  canLookUp: boolean;
  /** The candidates hold more than one version of the same card: "Choose the version" is offered. */
  severalVersions: boolean;
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
    candidates: (stored?.items ?? []).map((c, position) => ({ position, sourceId: c.sourceId, line: cardLine(c), verified: c.verified, url: sourceUrl(c.url) })),
    canLookUp: item.catalogCardId == null && Boolean(item.player?.trim() || item.cardNumber?.trim()),
    severalVersions: hasSeveralVersions(stored?.items ?? []),
  };
}
