import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { CATALOG_FIELDS, catalogCards, catalogSources, type CatalogField, type Item, items } from "@/db/schema";
import { countAuditSince, recordAudit } from "@/lib/audit/store";
import { itemLabel } from "@/lib/audit/subjects";
import { liveItem } from "@/lib/items/live";
import { CERTAIN_FIELDS, REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { applyCatalogCard, type CatalogDifference } from "./apply";
import { candidateCard, parseCatalog, serializeCatalog, type LinkedInfo, type NotCheckedReason, type StoredCandidate } from "./candidates";
import { sourceUrl } from "./clean";
import { cardLine } from "./line";
import { findCard } from "./find";
import { getCatalog } from "./provider";
import { saveCatalogCardIn } from "./store";
import type { Catalog, CatalogCard } from "./types";
import { normalizeText } from "./normalize";
import { fieldsToCheck, isFilled, parseFieldSources, parseFirstSuggestion, sourceOf } from "./sources";
import { buildTitle } from "@/lib/title";
import { baseWithVersions, buildVersionOptions, catalogVersionCards, catalogVersionName, hasSeveralVersions, isVersionRow, parseVersions, readTexts, serializeVersions } from "./versions";
import { knownVersionsFor } from "./versions-known";

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
  return db.transaction((tx): PickResult => pickCandidateIn(tx as unknown as Db, itemId, position, sourceId, now), { behavior: "immediate" });
}

/**
 * The same inside a caller's transaction. `auto`: the app links a verified
 * match by itself (S1a rule C); the list is kept with the link so Undo can
 * bring it back and the item page can show what the catalog knows.
 */
export function pickCandidateIn(
  tx: Db, itemId: number, position: number, sourceId: string, now: Date = new Date(), auto: LinkedInfo["before"] | false = false,
): PickResult {
  {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: GONE };
    if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
    if (item.catalogCardId != null) return { ok: false, error: ALREADY_LINKED };
    const stored = parseCatalog(item.catalogCandidates, now);
    const chosen = (stored?.status === "candidates" || stored?.status === "linked") && Number.isInteger(position) && position >= 0 ? stored.items[position] : undefined;
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
        // A link the app made by itself names the version from the catalog, not from the owner.
        marks.variation = auto === false ? "owner" : "catalog";
        patch.variation = name;
        patch.fieldSources = JSON.stringify(marks);
        patch.title = buildTitle({ ...after, variation: name });
        differences = differences.filter((d) => d.field !== "variation");
        version = { versionState: "confirmed", versionSource: "catalog", versionOptions: null };
      } else if (name) {
        // The owner's own variation says something else: nothing is decided, the difference is shown.
        differences = [...differences.filter((d) => d.field !== "variation"), { field: "variation", itemValue: after.variation ?? "", catalogValue: name }];
      }
    }
    const confirmed = differences.length === 0;
    // The list stays with the link (status `linked`): the item page shows what the catalog knows, Unlink brings the list back.
    const kept = serializeCatalog({ status: "linked", items: stored!.items, linked: { position, auto: auto !== false, before: auto || null } }, now);
    let extra: Partial<Item> = {};
    if (auto !== false) {
      // The catalog is the second, independent sign for the fields it agrees on:
      // they count as confirmed (marked `catalog`), so "Check this" goes away.
      // Unlink marks them `reading` again, and their "Check this" comes back.
      const after = { ...item, ...patch } as Item;
      const marks = parseFieldSources(after.fieldSources) ?? {};
      let changed = false;
      for (const f of CONFIRMED_BY_MATCH) {
        if (marks[f] === "reading" && isFilled(after[f]) && sameValue(after[f], row[f])) { marks[f] = "catalog"; changed = true; }
      }
      if (changed) extra = { fieldSources: JSON.stringify(marks) };
      if (confirmed) extra.confidence = Math.max(item.confidence ?? 0, REVIEW_THRESHOLD);
    }
    tx.update(items).set({
      ...patch, ...version, ...extra, catalogCandidates: kept, ...(confirmed ? { status: "confirmed" as const } : {}), updatedAt: now,
    }).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: true, line: cardLine(row), differences, confirmed };
  }
}

/** The fields a verified match confirms (S1a rule C). */
export const CONFIRMED_BY_MATCH = ["year", "brand", "cardNumber", "player"] as const satisfies readonly CatalogField[];

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;
}

/**
 * S1a rule C: a scan or "Look up again" found exactly one verified match,
 * stored first in the item's list. Linked as "This is my card" would, inside
 * the caller's transaction, remembering the status and confidence before so
 * Undo can put them back. False when it could not be linked (the list stays).
 */
export function autoLinkIn(tx: Db, itemId: number, now: Date = new Date()): boolean {
  const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item || item.kind !== "card" || item.catalogCardId != null) return false;
  const stored = parseCatalog(item.catalogCandidates, now);
  const first = stored?.status === "candidates" ? stored.items[0] : undefined;
  if (!first) return false;
  // One base entry with premium versions of the same card: the base is linked, the version stays an open question.
  const group = baseWithVersions(item, catalogVersionCards(item, stored!.items.filter((c) => c.verified)), readTexts(item));
  const assumed = group && group.base.sourceId === first.sourceId ? group : null;
  const hasVersions = stored!.items.some((c) => c.sourceId !== first.sourceId && isPremiumSibling(item, first, c));
  // A read version word with a base first: nothing is assumed, nothing is linked (the question stays as it is).
  if (!assumed && hasVersions && catalogVersionName(item, first) === "" && readNamesVersion(item)) return false;
  const before = { status: item.status === "confirmed" ? "confirmed" as const : "needs_review" as const, confidence: item.confidence };
  const res = pickCandidateIn(tx, itemId, 0, first.sourceId, now, before);
  if (!res.ok) return false;
  if (assumed) {
    const linked = tx.select().from(items).where(eq(items.id, itemId)).get()!;
    const options = buildVersionOptions(linked, [...[assumed.base, ...assumed.versions].map(candidateCard)]);
    tx.update(items).set({ versionOptions: serializeVersions({ catalog: "ok", options, assumed: true }, now) }).where(eq(items.id, itemId)).run();
  }
  return true;
}

function isPremiumSibling(item: Item, _base: StoredCandidate, c: StoredCandidate): boolean {
  return c.verified && catalogVersionCards(item, [c]).length === 1 && catalogVersionName(item, c) !== "";
}

function readNamesVersion(item: Item): boolean {
  const known = knownVersionsFor(item).map((r) => normalizeText(r.name));
  return readTexts(item).some((r) => known.some((k) => ` ${r} `.includes(` ${k} `)));
}

/**
 * Undo of a link the app made by itself, and Unlink: the link goes, the list
 * comes back to pick from, the catalog's marks become `reading` (so "Check
 * this" shows again). After an automatic link, the status and confidence
 * the item had before come back too.
 */
export function undoLink(itemId: number, db: Db = getDb(), now: Date = new Date()): { ok: boolean } {
  return db.transaction((tx) => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false };
    // Not linked (any more): nothing to undo, as the plain Unlink always was.
    if (item.catalogCardId == null) return { ok: true };
    const stored = parseCatalog(item.catalogCandidates, now);
    const patch: Partial<Item> = { catalogCardId: null, updatedAt: now };
    // An assumed normal version goes with the link it came from.
    if (parseVersions(item.versionOptions, now)?.assumed) patch.versionOptions = null;
    const marks = parseFieldSources(item.fieldSources);
    if (marks) {
      let changed = false;
      for (const f of CATALOG_FIELDS) if (marks[f] === "catalog") { marks[f] = "reading"; changed = true; }
      if (changed) patch.fieldSources = JSON.stringify(marks);
    }
    if (stored?.status === "linked") {
      patch.catalogCandidates = stored.items.length > 0 ? serializeCatalog({ status: "candidates", items: stored.items }, new Date(stored.at)) : null;
      const before = stored.linked?.auto ? stored.linked.before : null;
      if (before) {
        patch.status = before.status;
        patch.confidence = before.confidence;
      }
    }
    const res = tx.update(items).set(patch).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: res.changes > 0 };
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
  | { ok: true; found: number; notChecked: NotCheckedReason | null; matched?: string | null }
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
  let matched: string | null = null;
  try {
    // The item's fields of the moment. A field the reader was not sure of (and nobody changed) counts as unsure.
    const r = await findCard({
      sport: item.sport, year: item.year, brand: item.brand, setName: item.setName, cardNumber: item.cardNumber,
      player: item.player, team: item.team, variation: item.variation || parseFirstSuggestion(item.firstSuggestion)?.fields.variation || null, unsure: fieldsToCheck(item).filter((f): f is (typeof CERTAIN_FIELDS)[number] => (CERTAIN_FIELDS as readonly string[]).includes(f)),
    }, "now", { catalog: deps.catalog ?? getCatalog() });
    found = r.candidates.length;
    if (r.match) matched = cardLine(r.match);
    if (found > 0) stored = serializeCatalog({ status: "candidates", items: r.candidates }, now());
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
    if (res.changes > 0) {
      // Exactly one verified match: linked as at a scan (S1a rule C), with Undo on the item page.
      if (matched && !autoLinkIn(tx as unknown as Db, itemId, now())) matched = null;
      return { ok: true, found, notChecked, ...(matched ? { matched } : {}) };
    }
    const now2 = tx.select({ link: items.catalogCardId }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
    return { ok: false, error: now2 ? ALREADY_LINKED : GONE };
  }, { behavior: "immediate" });
}

/** The plain result line of "Look up again" (S1a rule G). */
export function lookUpAgainLine(r: LookupAgainResult): string {
  if (!r.ok) return r.error;
  if (r.matched) return `Matched to the catalog: ${r.matched}.`;
  if (r.found > 0) return r.found === 1 ? "Found 1 possible card." : `Found ${r.found} possible cards.`;
  if (r.notChecked) return r.notChecked === "off" ? "The card catalog is switched off." : "The catalog did not answer. Try again later.";
  return "None found in the catalog. Check the year, brand and player, then try again.";
}

/** What Review shows for one item: the catalog's part, in plain data for the screen. */
export type ReviewCatalogView = {
  /** Linked card line and the fields the scanner read differently. */
  linked: { line: string; url: string | null; differences: { label: string; read: string; catalog: string }[] } | null;
  status: "candidates" | "none" | "not_checked" | null;
  reason: NotCheckedReason | null;
  /** `differs`: how it differs from what the card reads, in plain words. */
  candidates: { position: number; sourceId: string; line: string; verified: boolean; url: string | null; differs: string | null }[];
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
        differences: differences.map((d) => ({ label: FIELD_WORDS[d.field], read: d.itemValue == null ? "" : String(d.itemValue), catalog: d.catalogValue == null ? "" : String(d.catalogValue) })),
      };
    }
  }
  const stored = item.catalogCardId == null ? parseCatalog(item.catalogCandidates, now) : null;
  return {
    linked,
    // A list kept from a link that is gone is a list to pick from again.
    status: stored?.status === "linked" ? "candidates" : stored?.status ?? null,
    reason: stored?.reason ?? null,
    candidates: (stored?.items ?? []).map((c, position) => ({
      position, sourceId: c.sourceId, line: cardLine(c), verified: c.verified, url: sourceUrl(c.url), differs: c.differs ?? null,
    })),
    canLookUp: item.catalogCardId == null && Boolean(item.player?.trim() || item.cardNumber?.trim()),
    severalVersions: hasSeveralVersions(stored?.items ?? []),
  };
}

/** What the item page shows about its linked catalog card (S1a rule F). */
export type LinkedFacts = {
  line: string;
  /** The app linked it by itself (a verified match): "Matched to the catalog" with Undo. */
  auto: boolean;
  setName: string | null;
  cardNumber: string | null;
  team: string | null;
  /** The catalog's card details text, such as rookie or variation wording. */
  details: string | null;
  /** "Open in the catalog". */
  url: string | null;
  verified: boolean;
  /** A clean entry marks it a rookie card (RC or "Rookie" wording): offered as a suggestion only. */
  rookie: boolean;
  /** Fields the catalog confirmed after a verified match. */
  confirmed: CatalogField[];
};

const ROOKIE_WORDING = /\bRC\b|\brookie\b/i;

/** A clean catalog entry's own words mark it a rookie card. Listings are never trusted for this. */
export function catalogSaysRookie(c: Pick<StoredCandidate, "verified" | "details" | "setName">): boolean {
  return c.verified && (ROOKIE_WORDING.test(c.details ?? "") || ROOKIE_WORDING.test(c.setName ?? ""));
}

export function linkedFacts(item: Item, db: Db = getDb(), now: Date = new Date()): LinkedFacts | null {
  if (item.kind !== "card" || item.catalogCardId == null) return null;
  const row = db.select().from(catalogCards).where(eq(catalogCards.id, item.catalogCardId)).get();
  if (!row) return null;
  const src = db.select({ url: catalogSources.url, sourceId: catalogSources.sourceId }).from(catalogSources).where(eq(catalogSources.catalogCardId, row.id)).all();
  const stored = parseCatalog(item.catalogCandidates, now);
  const kept = stored?.status === "linked" && stored.linked ? stored.items[stored.linked.position] : undefined;
  // The kept row only when it is this very card.
  const chosen = kept && src.some((s) => s.sourceId === kept.sourceId) ? kept : undefined;
  const auto = Boolean(chosen && stored?.linked?.auto);
  const marks = parseFieldSources(item.fieldSources);
  return {
    line: cardLine(row),
    auto,
    setName: row.setName ?? chosen?.setName ?? null,
    cardNumber: row.cardNumber,
    team: row.team ?? (chosen?.verified ? chosen.team : null) ?? null,
    details: chosen?.details ?? null,
    url: sourceUrl(chosen?.url) ?? sourceUrl(src[0]?.url),
    verified: row.verified !== false,
    rookie: chosen ? catalogSaysRookie(chosen) : false,
    confirmed: auto ? CONFIRMED_BY_MATCH.filter((f) => marks?.[f] === "catalog" && isFilled(item[f]) && sameValue(item[f], row[f])) : [],
  };
}
