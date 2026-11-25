import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { CATALOG_FIELDS, catalogCards, items, type Item, type VersionSource, type VersionState } from "@/db/schema";
import { countAuditSince, recordAudit } from "@/lib/audit/store";
import { itemLabel } from "@/lib/audit/subjects";
import { liveItem } from "@/lib/items/live";
import { buildTitle } from "@/lib/title";
import { applyCatalogCard, type CatalogDifference } from "./apply";
import { candidateCard, slimCandidate, storedCandidateSchema, type StoredCandidate } from "./candidates";
import { sourceUrl } from "./clean";
import { cardLine } from "./line";
import { firstFits, parseName } from "./match";
import { normalizeBrand, normalizeText, printedCardNumber } from "./normalize";
import { getCatalog } from "./provider";
import { parseFieldSources, parseFirstSuggestion, sourceOf } from "./sources";
import { saveCatalogCardIn } from "./store";
import type { Catalog, CatalogCard, CatalogFailure } from "./types";
import { knownVersionsFor } from "./versions-known";

/**
 * "Which version is it?" (PLAN Milestone 11, F04). The app suggests, the
 * owner chooses: `loadVersionOptions` only stores a list on the item
 * (`items.versionOptions`) and changes no field; `chooseVersion` is the one
 * path that writes a version, and only for the option at the position the
 * owner tapped in the list the server stored.
 */

export const MAX_VERSION_OPTIONS = 12;
/** A stored list older than this is not used any more. */
export const VERSION_DAYS = 30;
/** "Show versions" once per 10 seconds per item. */
export const SHOW_EVERY_MS = 10_000;
/** "Show versions" for all items together: 6 per minute, counted from the activity log (a restart does not reset it). */
export const SHOW_PER_MINUTE = 6;
/** Longest version name the owner may type for "Another version". */
export const ANOTHER_MIN = 2;
export const ANOTHER_MAX = 120;
const MAX_EVIDENCE = 3;
const SEARCH_LIMIT = 20;

export const BASE_NAME = "The normal card (base)";
export const ANOTHER_NAME = "Another version";
export const NOT_SURE_NAME = "Not sure yet";

export const GONE = "This item no longer exists.";
export const NOT_A_CARD = "Only a single card has a version.";
export const LIST_CHANGED = "That list has changed. Tap Show versions again.";
export const SHOW_WAIT = "Wait a few seconds before showing the versions again.";
export const SHOW_BUSY = "Too many version lists were asked for in the last minute. Wait a minute and try again.";
export const ANOTHER_NEEDS = `Type the name of the version (${ANOTHER_MIN} to ${ANOTHER_MAX} characters).`;

export type EvidenceFrom = "catalog" | "known_list" | "reading";
export type Evidence = { from: EvidenceFrom; text: string; url: string | null };
export type OptionKind = "base" | "version" | "another" | "not_sure";
export type VersionOption = {
  kind: OptionKind;
  name: string;
  evidence: Evidence[];
  /** The catalog entry this option links to when chosen (versions only). */
  card: StoredCandidate | null;
  /** The known versions list row, when the option is on it. */
  knownId: string | null;
};
/** How the catalog part went: `not_asked` when the item lacks year, brand or player. */
export type CatalogStatus = "ok" | "none" | "not_asked" | CatalogFailure;
export const CATALOG_STATUSES = ["ok", "none", "not_asked", "off", "paused", "cap", "busy", "failed"] as const satisfies readonly CatalogStatus[];
/** `assumed`: the app linked the normal card by itself and the question is still open (nothing is the owner's answer). */
export type StoredVersions = { at: number; catalog: CatalogStatus; options: VersionOption[]; assumed?: boolean };

/** The item facts the list is built from. */
export type VersionItem = Pick<Item, "kind" | "sport" | "year" | "brand" | "setName" | "cardNumber" | "player" | "team" | "variation" | "fieldSources" | "firstSuggestion">;

// ---------- building the list (pure) ----------

function samePlayer(a: string | null, b: string | null): boolean {
  const x = parseName(a);
  const y = parseName(b);
  if (!x || !y) return false;
  return x.surname === y.surname && x.suffix === y.suffix && firstFits(x.first, y.first) && firstFits(y.first, x.first);
}

/** The version a catalog entry stands for, as it differs from the item's own brand and set. Empty: the normal card. */
export function catalogVersionName(item: Pick<VersionItem, "brand" | "setName">, card: Pick<CatalogCard, "brand" | "variation" | "setName">): string {
  const parts: string[] = [];
  if (card.brand && normalizeBrand(card.brand) !== normalizeBrand(item.brand ?? "")) parts.push(card.brand);
  if (card.variation) parts.push(card.variation);
  // Upper Deck writes its parallel into the set: "Base Set Electric Diamond".
  const set = card.setName?.replace(/^base set\s+/i, "").trim() || null;
  if (set && normalizeText(set) !== normalizeText(item.setName ?? "") && normalizeText(set) !== normalizeText(card.variation ?? "")) parts.push(set);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, ANOTHER_MAX);
}

/**
 * The catalog entries that are a version of the item's card: clean entries
 * only, same year, same player, same card number (when the item has one).
 * Unverified listings are never options.
 */
export function catalogVersionCards<C extends Pick<CatalogCard, "verified" | "year" | "player" | "cardNumber">>(
  item: Pick<VersionItem, "year" | "cardNumber" | "player">, cards: readonly C[],
): C[] {
  const number = item.cardNumber?.trim() ? printedCardNumber(item.cardNumber) : null;
  return cards.filter((c) =>
    c.verified && c.year != null && c.year === item.year && samePlayer(item.player, c.player) &&
    (number === null || (c.cardNumber != null && printedCardNumber(c.cardNumber) === number)));
}

/**
 * One base entry plus premium versions of the same card. `cards` are the
 * verified matches (or stored candidates). The base is the one entry that
 * is the plain product; every other entry must be the same year, number and
 * player, and its product the base product plus a word of the known versions
 * list for this year and brand ("Tiffany", "Glossy", "Desert Shield", "Gold").
 * Null for no base, two bases, any entry that is not a known version, or when
 * the card's own reading names a version (`readNames`, the words read).
 */
export function baseWithVersions<C extends Pick<CatalogCard, "verified" | "year" | "player" | "cardNumber" | "brand" | "variation" | "setName">>(
  item: Pick<VersionItem, "sport" | "year" | "brand" | "setName" | "cardNumber" | "player">, cards: readonly C[], readNames: readonly string[] = [],
): { base: C; versions: C[] } | null {
  const same = catalogVersionCards(item, cards);
  if (same.length < 2 || same.length !== cards.length) return null;
  const known = knownVersionsFor(item).map((r) => normalizeText(r.name));
  if (known.length === 0) return null;
  const reads = readNames.map(normalizeText).filter(Boolean);
  if (reads.some((r) => known.some((k) => ` ${r} `.includes(` ${k} `)))) return null;
  const bases = same.filter((c) => catalogVersionName(item, c) === "");
  if (bases.length !== 1) return null;
  const versions = same.filter((c) => c !== bases[0]);
  const premium = versions.every((c) => known.includes(normalizeText(catalogVersionName(item, c))));
  return premium ? { base: bases[0], versions } : null;
}

/** Version words the reader left on the item: its `reading` variation and the first suggestion's variation. */
export function readTexts(item: VersionItem): string[] {
  const out: string[] = [];
  if (item.variation?.trim() && sourceOf(item, "variation") === "reading") out.push(item.variation);
  const first = parseFirstSuggestion(item.firstSuggestion)?.fields.variation;
  if (first?.trim()) out.push(first);
  return out.map(normalizeText).filter(Boolean);
}

function readEvidence(name: string): Evidence {
  const words = name.toUpperCase();
  return { from: "reading", text: `The reader read the ${name.trim().includes(" ") ? "words" : "word"} ${words} on the card`, url: null };
}

function addEvidence(o: VersionOption, e: Evidence): void {
  if (o.evidence.length >= MAX_EVIDENCE) return;
  if (o.evidence.some((x) => x.from === e.from && x.text === e.text)) return;
  o.evidence.push(e);
}

function catalogEvidence(c: CatalogCard | StoredCandidate): Evidence {
  return { from: "catalog", text: `In the catalog: ${cardLine(c)}`, url: sourceUrl(c.url) };
}

/**
 * The list of choices, in the settled order: base, options with read
 * evidence, catalog options, known list options, another, not sure. At most
 * 12. The same version from two sources is one option with both lines. A read
 * word only moves its option to second place; it never adds or chooses one.
 */
export function buildVersionOptions(item: VersionItem, catalog: readonly CatalogCard[]): VersionOption[] {
  const base: VersionOption = { kind: "base", name: BASE_NAME, evidence: [], card: null, knownId: null };
  const byKey = new Map<string, VersionOption & { group: number }>();
  for (const c of catalogVersionCards(item, catalog)) {
    const name = catalogVersionName(item, c);
    if (!name) {
      addEvidence(base, catalogEvidence(c));
      // The catalog's own base card, kept so "The normal card" can link it.
      base.card ??= slimCandidate(c);
      continue;
    }
    const key = normalizeText(name);
    const known = byKey.get(key);
    if (known) {
      addEvidence(known, catalogEvidence(c));
      continue;
    }
    byKey.set(key, { kind: "version", name, evidence: [catalogEvidence(c)], card: slimCandidate(c), knownId: null, group: 1 });
  }
  for (const row of knownVersionsFor(item)) {
    const key = normalizeText(row.name);
    const e: Evidence = { from: "known_list", text: `Known versions list: ${row.howToTell}`, url: null };
    const known = byKey.get(key);
    if (known) {
      known.knownId ??= row.id;
      addEvidence(known, e);
    } else {
      byKey.set(key, { kind: "version", name: row.name, evidence: [e], card: null, knownId: row.id, group: 2 });
    }
  }
  const reads = readTexts(item);
  const middle = [...byKey.values()];
  for (const o of middle) {
    const key = normalizeText(o.name);
    if (reads.some((r) => ` ${r} `.includes(` ${key} `))) {
      // The read line goes first under the name.
      o.evidence.unshift(readEvidence(o.name));
      o.evidence.splice(MAX_EVIDENCE);
      o.group = 0;
    }
  }
  middle.sort((a, b) => a.group - b.group);
  const chosen: VersionOption[] = middle.slice(0, MAX_VERSION_OPTIONS - 3)
    .map((o) => ({ kind: o.kind, name: o.name, evidence: o.evidence, card: o.card, knownId: o.knownId }));
  return [
    base,
    ...chosen,
    { kind: "another", name: ANOTHER_NAME, evidence: [], card: null, knownId: null },
    { kind: "not_sure", name: NOT_SURE_NAME, evidence: [], card: null, knownId: null },
  ];
}

/**
 * True when the stored catalog candidates of an item hold more than one
 * version of the same card (same year, number and player, other variation).
 * Review and the item page then show "There is more than one version of this card".
 */
export function hasSeveralVersions(candidates: readonly StoredCandidate[]): boolean {
  const seen = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!c.verified || c.year == null || !c.cardNumber) continue;
    const name = parseName(c.player);
    if (!name) continue;
    const key = `${c.year}|${printedCardNumber(c.cardNumber)}|${name.surname}`;
    const kinds = seen.get(key) ?? new Set<string>();
    kinds.add(normalizeText(`${normalizeBrand(c.brand ?? "")} ${c.variation ?? ""} ${c.setName ?? ""}`));
    seen.set(key, kinds);
    if (kinds.size > 1) return true;
  }
  return false;
}

/**
 * A catalog row whose line shows a version ("Topps Tiffany", or a parallel
 * Upper Deck writes into the set: "Base Set Electric Diamond"). A pick of such
 * a row in Review is the owner's choice of that version.
 */
export function isVersionRow(c: Pick<StoredCandidate, "variation" | "setName">): boolean {
  return Boolean(c.variation?.trim()) || /^base set\s+\S/i.test(c.setName ?? "");
}

// ---------- the stored list ----------

const evidenceSchema = z.object({
  from: z.enum(["catalog", "known_list", "reading"]),
  text: z.string().min(1).max(300),
  url: z.string().max(400).nullable(),
});
const optionSchema = z.object({
  kind: z.enum(["base", "version", "another", "not_sure"]),
  name: z.string().min(1).max(ANOTHER_MAX),
  evidence: z.array(evidenceSchema).max(MAX_EVIDENCE),
  card: storedCandidateSchema.nullable(),
  knownId: z.string().max(60).nullable(),
});
const storedSchema = z.object({
  v: z.literal(1),
  at: z.number().int(),
  catalog: z.enum(CATALOG_STATUSES),
  options: z.array(optionSchema).min(1).max(MAX_VERSION_OPTIONS),
  assumed: z.boolean().optional(),
});

export function serializeVersions(v: { catalog: CatalogStatus; options: VersionOption[]; assumed?: boolean }, at: Date): string {
  return JSON.stringify({ v: 1, at: at.getTime(), catalog: v.catalog, options: v.options.slice(0, MAX_VERSION_OPTIONS), ...(v.assumed ? { assumed: true } : {}) });
}

/** Reads the stored list. Null when there is none, it cannot be read, or it is older than 30 days. */
export function parseVersions(raw: string | null | undefined, now: Date = new Date()): StoredVersions | null {
  if (!raw) return null;
  try {
    const r = storedSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    if (now.getTime() - r.data.at > VERSION_DAYS * 24 * 60 * 60 * 1000) return null;
    return { at: r.data.at, catalog: r.data.catalog, options: r.data.options, ...(r.data.assumed ? { assumed: true } : {}) };
  } catch {
    return null;
  }
}

// ---------- "Show versions" (may spend catalog calls) ----------

const holder = globalThis as unknown as { __crdShowVersions?: Map<number, number> };
function lastShown(): Map<number, number> {
  holder.__crdShowVersions ??= new Map();
  return holder.__crdShowVersions;
}
/** Tests start clean. */
export function resetShowVersionsLimitForTests(): void {
  lastShown().clear();
}

const SUFFIX_WORD = /^(jr|sr|ii|iii|iv)\.?$/i;
function surnameWord(player: string): string | null {
  const words = player.replace(/[([{][^)\]}]*(?:[)\]}]|$)/g, " ").replace(/,/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIX_WORD.test(words[words.length - 1])) words.pop();
  return words.length > 0 ? words[words.length - 1] : null;
}

/** The searches for one tap: "year brand number surname", and "year brand full name" only when the item has no number. */
export function versionSearches(item: VersionItem): string[] {
  if (item.year == null || !item.brand?.trim() || !item.player?.trim()) return [];
  const surname = surnameWord(item.player.trim());
  if (!surname) return [];
  const number = item.cardNumber?.trim() || null;
  const first = [String(item.year), item.brand.trim(), number, surname].filter(Boolean).join(" ");
  const out = [first];
  if (!number) {
    const second = `${item.year} ${item.brand.trim()} ${item.player.trim()}`;
    if (second.toLowerCase() !== first.toLowerCase()) out.push(second);
  }
  return out;
}

export type ShowResult = { ok: true; versions: StoredVersions } | { ok: false; error: string };

/**
 * "Show versions": asks the catalog (at most 2 calls, `now` line, through the
 * gate; a stored answer costs nothing), builds the list and stores it on the
 * item. Changes no field and chooses nothing. Catalog off, paused or busy:
 * the known list and the three fixed options still come back.
 */
export async function loadVersionOptions(itemId: number, deps: { db?: Db; catalog?: Catalog; now?: () => Date; who?: { ip?: string; deviceId?: string | null } } = {}): Promise<ShowResult> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? (() => new Date());
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: GONE };
  if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
  const seen = lastShown();
  const t = now().getTime();
  const last = seen.get(itemId);
  if (last !== undefined && t - last < SHOW_EVERY_MS) return { ok: false, error: SHOW_WAIT };
  if (countAuditSince(["versions_shown"], new Date(t - 60_000), db) >= SHOW_PER_MINUTE) return { ok: false, error: SHOW_BUSY };
  seen.set(itemId, t);
  recordAudit({ event: "versions_shown", outcome: "ok", ip: deps.who?.ip ?? "unknown", deviceId: deps.who?.deviceId, detail: itemLabel(itemId, db) }, { db, now: now() });
  if (seen.size > 1000) for (const [k, v] of seen) if (t - v >= SHOW_EVERY_MS) seen.delete(k);

  const searches = versionSearches(item);
  let status: CatalogStatus = searches.length === 0 ? "not_asked" : "none";
  const found: CatalogCard[] = [];
  if (searches.length > 0) {
    const catalog = deps.catalog ?? getCatalog();
    let failure: CatalogFailure | null = null;
    let answered = false;
    for (const text of searches) {
      try {
        const r = await catalog.search({ text, sport: item.sport ?? undefined, year: item.year ?? undefined, limit: SEARCH_LIMIT }, "now");
        if (r.ok) {
          answered = true;
          found.push(...r.value);
        } else {
          failure = r.reason;
          // Off, paused or capped will not change for the second search.
          if (r.reason !== "failed") break;
        }
      } catch {
        failure = "failed";
      }
    }
    if (answered) status = catalogVersionCards(item, found).length > 0 ? "ok" : "none";
    else status = failure ?? "failed";
  }
  const options = buildVersionOptions(item, found);
  const versions: StoredVersions = { at: now().getTime(), catalog: status, options };
  // An open "assumed the normal version" stays assumed when the owner only looks at the list again.
  const keepAssumed = item.versionState == null && item.catalogCardId != null && parseVersions(item.versionOptions, now())?.assumed === true;
  if (keepAssumed) versions.assumed = true;
  const stored = serializeVersions(versions, new Date(versions.at));
  const res = db.update(items).set({ versionOptions: stored }).where(and(eq(items.id, itemId), liveItem)).run();
  if (res.changes === 0) return { ok: false, error: GONE };
  return { ok: true, versions };
}

// ---------- the owner's choice ----------

export type ChooseInput = { position: number; listAt: number; text?: string | null };
export type ChooseResult =
  | { ok: true; state: VersionState; source: VersionSource | null; differences: CatalogDifference[] }
  | { ok: false; error: string };

/**
 * The one path that writes a version. The option is taken by its position in
 * the list the server stored (and that list must be the one the owner saw,
 * `listAt`), never from fields the browser sends; only the typed name of
 * "Another version" comes from the browser.
 * - Base: `variation` emptied, `isParallel` false, confirmed.
 * - A version: `variation` set and marked `owner`, `isParallel` true,
 *   confirmed; a catalog option links that catalog card by the filling rule
 *   (owner fields stay, differences listed) and replaces another link.
 * - Another version: the typed name, source `owner`.
 * - Not sure yet: state `not_sure`, no field changed.
 * The stored list is cleared. `firstSuggestion`, values and the rookie mark are never touched.
 */
export function chooseVersion(itemId: number, input: ChooseInput, db: Db = getDb(), now: Date = new Date()): ChooseResult {
  return db.transaction((tx): ChooseResult => {
    const item = tx.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { ok: false, error: GONE };
    if (item.kind !== "card") return { ok: false, error: NOT_A_CARD };
    const stored = parseVersions(item.versionOptions, now);
    if (!stored || stored.at !== input.listAt) return { ok: false, error: LIST_CHANGED };
    const option = Number.isInteger(input.position) && input.position >= 0 ? stored.options[input.position] : undefined;
    if (!option) return { ok: false, error: LIST_CHANGED };

    if (option.kind === "not_sure") {
      tx.update(items).set({ versionState: "not_sure", versionSource: null, versionOptions: null, updatedAt: now })
        .where(and(eq(items.id, itemId), liveItem)).run();
      return { ok: true, state: "not_sure", source: null, differences: [] };
    }

    let variation: string | null;
    let source: VersionSource;
    if (option.kind === "base") {
      variation = null;
      source = "owner";
    } else if (option.kind === "another") {
      const typed = String(input.text ?? "").replace(/\s+/g, " ").trim();
      if (typed.length < ANOTHER_MIN || typed.length > ANOTHER_MAX) return { ok: false, error: ANOTHER_NEEDS };
      variation = typed;
      source = "owner";
    } else {
      variation = option.name;
      source = option.card ? "catalog" : "known_list";
    }

    // The variation is the owner's from now on (or loses its mark when emptied).
    const marks = parseFieldSources(item.fieldSources);
    if (marks) {
      if (variation === null) delete marks.variation;
      else marks.variation = "owner";
    }
    let next: Item = {
      ...item, variation, isParallel: option.kind !== "base",
      fieldSources: marks ? JSON.stringify(marks) : item.fieldSources,
    };
    let differences: CatalogDifference[] = [];
    // What the old link filled counts as read from now on, as after Unlink,
    // so a new card lists its differences instead of treating them as the owner's.
    const forgetLink = () => {
      const m = parseFieldSources(next.fieldSources);
      if (m) {
        for (const f of CATALOG_FIELDS) if (m[f] === "catalog") m[f] = "reading";
        next = { ...next, fieldSources: JSON.stringify(m) };
      }
    };
    const linked = item.catalogCardId != null ? tx.select().from(catalogCards).where(eq(catalogCards.id, item.catalogCardId)).get() : undefined;
    const linkedIsBase = Boolean(linked) && catalogVersionName(item, linked!) === "";
    if (option.card && (option.kind === "version" || option.kind === "base")) {
      const saved = saveCatalogCardIn(tx as unknown as Db, candidateCard(option.card), now);
      if (!saved.ok) return { ok: false, error: saved.error };
      const row = tx.select().from(catalogCards).where(eq(catalogCards.id, saved.catalogCardId)).get();
      if (!row) return { ok: false, error: "That catalog card no longer exists." };
      if (next.catalogCardId != null && next.catalogCardId !== row.id) forgetLink();
      const applied = applyCatalogCard(next, row);
      next = { ...next, ...applied.patch, catalogCardId: row.id };
      differences = applied.differences;
    } else if (item.catalogCardId != null && ((option.kind === "base" && !linkedIsBase) || (option.kind === "version" && linkedIsBase))) {
      // Base with no base card in the list while linked to another version, or a known-list
      // version (no catalog card) while linked to the base card: the link would say the opposite, so it goes.
      forgetLink();
      next = { ...next, catalogCardId: null };
    }
    tx.update(items).set({
      variation: next.variation, isParallel: next.isParallel, fieldSources: next.fieldSources,
      sport: next.sport, year: next.year, brand: next.brand, setName: next.setName, cardNumber: next.cardNumber,
      player: next.player, team: next.team, catalogCardId: next.catalogCardId,
      title: buildTitle(next), versionState: "confirmed", versionSource: source, versionOptions: null,
      ...(next.catalogCardId !== item.catalogCardId ? { catalogCandidates: null } : {}),
      updatedAt: now,
    }).where(and(eq(items.id, itemId), liveItem)).run();
    return { ok: true, state: "confirmed", source, differences };
  }, { behavior: "immediate" });
}
