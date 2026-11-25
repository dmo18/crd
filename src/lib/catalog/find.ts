import type { Sport } from "@/db/schema";
import { PRODUCT_NAMES } from "@/lib/free/parse";
import type { CertainField } from "@/lib/recognition/types";
import { MAX_STORED_CANDIDATES, type OfferCandidate } from "./candidates";
import { cleanCardNumber, setIdFromUrl } from "./clean";
import { createScanBudget, type ScanBudget } from "./lookup";
import { baseWithVersions } from "./versions";
import { firstFits, parseName, type Candidate } from "./match";
import { createMyCardfolio } from "./mycardfolio";
import { normalizeBrand, normalizeName, normalizeText } from "./normalize";
import type { CallLimits, Catalog, CatalogCard, CatalogFailure, CatalogResult, Line } from "./types";

/**
 * Finding one read card in the catalog with few calls (S1a). Rules only, no
 * guessing: docs/PLAN.md, "S1a catalog".
 * A. One short ordered list of searches: product first, accents stripped,
 *    the card number when read, never filler searches. At most 3 searches,
 *    and 1 checklist call (rule D).
 * B. A candidate is offered only for the read player, once, unverified
 *    listings last, and one that contradicts a sure year or number not at all.
 * C. A verified match: a clean entry whose player, number, year and brand or
 *    product agree with the card. Exactly one is linked by the app.
 * D. A missing player or number may come from the set's checklist, as unsure.
 */

/** What the card reads. `unsure`: read fields the reader was not sure of; every other filled field counts as sure. */
export type FindRead = {
  sport: Sport | null;
  year: number | null;
  /** The year came only from the stat rows (the set may be of the year before): never a verified match. */
  yearFromStats?: boolean;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  player: string | null;
  team: string | null;
  /** The version words the card reads ("Tiffany"), when any. A read version is never assumed away. */
  variation?: string | null;
  unsure: readonly CertainField[];
  /**
   * Filled fields whose value was not read from the card (the catalog, its
   * set list, the key card list, Wikidata). A verified match needs player,
   * number, year and maker or product read from the card or given by the owner.
   */
  notRead?: readonly CertainField[];
};

export type FindStop = "budget" | CatalogFailure;

/** A field the checklist filled (or confirmed when `value` equals what was read). */
export type ChecklistFill = { field: "player" | "team" | "cardNumber"; value: string; sure: boolean };

export type FindResult = {
  /** Up to 5, in the order to show, the verified match first. */
  candidates: OfferCandidate[];
  /** The one to link: exactly one verified match, or the plain base entry when the other matches are premium versions of it. Null otherwise (then a version question). */
  match: OfferCandidate | null;
  /** How many verified matches there were (2 or more: "Which version is it?"). */
  matches: number;
  fills: ChecklistFill[];
  /** Plain words for the item's notes. */
  notes: string[];
  callsUsed: number;
  stopped: FindStop | null;
};

/** Normal case 3 searches, plus 1 checklist call. */
export const FIND_CALLS = 4;
const SEARCH_LIMIT = 10;
const MAX_TRIES = 2;
const MAX_QUERIES = 3;

// ---------- A. the searches ----------

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const SUFFIX_WORD = /^(jr|sr|ii|iii|iv)\.?$/i;
const PARTICLE_WORDS = new Set(["de", "la", "del", "los", "las", "da", "di", "le", "van", "von", "st", "st.", "mc", "o"]);

/** The name as the catalog spells it: accents and brackets off, spaces tidy. */
export function plainName(name: string | null | undefined): string | null {
  const t = stripAccents(String(name ?? "")).replace(/[([{][^)\]}]*(?:[)\]}]|$)/g, " ").replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t.slice(0, 80) : null;
}

/** The surname words for a search: "Ronald Acuña Jr." gives "Acuna", "Elly De La Cruz" gives "De La Cruz". */
export function surnameWords(name: string | null | undefined): string | null {
  const plain = plainName(name);
  if (!plain) return null;
  const words = plain.split(" ");
  while (words.length > 1 && SUFFIX_WORD.test(words[words.length - 1])) words.pop();
  const out = [words.pop()!];
  if (words.length >= 2) while (words.length > 1 && PARTICLE_WORDS.has(words[words.length - 1].toLowerCase())) out.unshift(words.pop()!);
  const s = out.join(" ").replace(/[^A-Za-z0-9' .-]/g, "").trim();
  return s.length >= 2 ? s : null;
}

/**
 * The product the catalog files the card under: a read set name that is a
 * product of the maker and product table ("Prizm", "Topps Chrome"), else the
 * maker ("Donruss").
 */
export function productOf(brand: string | null | undefined, setName: string | null | undefined): string | null {
  const set = setName?.trim();
  if (set && PRODUCT_NAMES.some((p) => normalizeBrand(p) === normalizeBrand(set))) return stripAccents(set);
  const b = brand?.trim();
  return b ? stripAccents(b) : null;
}

export type FindQuery = { text: string; year: number | null; sport: Sport | null };

const unsureOf = (read: Pick<FindRead, "unsure">, f: CertainField) => read.unsure.includes(f);

/**
 * The ordered searches for one card, at most 3: year, product, number and
 * surname; then year, product and surname (a misread number); then year,
 * product and number only when the name is missing or unsure.
 */
export function buildQueries(read: FindRead): FindQuery[] {
  const prefix = [read.year != null ? String(read.year) : null, productOf(read.brand, read.setName)].filter((p): p is string => Boolean(p));
  const sur = surnameWords(read.player);
  const num = cleanCardNumber(read.cardNumber);
  const texts: string[] = [];
  if (sur && num) texts.push([...prefix, num, sur].join(" "));
  if (sur) texts.push([...prefix, sur].join(" "));
  if (num && prefix.length > 0 && (!sur || unsureOf(read, "player"))) texts.push([...prefix, num].join(" "));
  const out: FindQuery[] = [];
  for (const text of texts) {
    if (text.length >= 2 && !out.some((q) => q.text.toLowerCase() === text.toLowerCase())) out.push({ text, year: read.year, sport: read.sport });
  }
  return out.slice(0, MAX_QUERIES);
}

/** The words for "Find this card in the catalog": year, product, number and player. */
export function searchWords(item: { year: number | null; brand: string | null; setName: string | null; cardNumber: string | null; player: string | null }): string {
  const parts = [item.year != null ? String(item.year) : null, productOf(item.brand, item.setName), cleanCardNumber(item.cardNumber), plainName(item.player)];
  return parts.filter(Boolean).join(" ").slice(0, 80);
}

// ---------- B. which candidates are offered ----------

const LEADERS = /\bleaders?\b/i;

/** A card of several players, or a leaders card: never offered for one read player. */
export function isGroupCard(c: Pick<CatalogCard, "player" | "otherPlayers" | "setName">): boolean {
  return c.otherPlayers.length > 0 || LEADERS.test(c.player ?? "") || LEADERS.test(c.setName ?? "") || /&|\band\b/i.test(c.player ?? "");
}

/**
 * The read player and the catalog's player are the same person: the surname
 * equal (accents and case ignored), Jr. and Sr. not against each other, and a
 * first name or initial, when both have one, not against each other ("Tim"
 * is not "Anfernee").
 */
export function playerAgrees(readPlayer: string | null | undefined, catalogPlayer: string | null | undefined): boolean {
  const r = parseName(readPlayer);
  const t = parseName(catalogPlayer);
  if (!r || !t) return false;
  if (r.surname !== t.surname) return false;
  if (r.suffix && t.suffix && r.suffix !== t.suffix) return false;
  if (r.first && t.first && !firstFits(r.first, t.first) && !firstFits(t.first, r.first)) return false;
  return true;
}

/** An unverified listing: not a clean id, or a "brand" that is the player's own name (a seller's title). */
export function isUnverified(c: Pick<CatalogCard, "verified" | "brand" | "player">): boolean {
  if (!c.verified) return true;
  const b = normalizeName(c.brand ?? "");
  const p = normalizeName(c.player ?? "");
  return p.length > 0 && b.includes(p);
}

/**
 * B: the candidates to offer, in order: clean entries that agree, clean
 * entries that differ from an unsure year or number (with the difference in
 * plain words), then unverified listings, marked. A candidate of another
 * player, a group or leaders card, or one against a sure year or number is
 * left out. Duplicates (same id, or same year, product, number and player) once.
 */
export function offerCandidates(read: FindRead, cards: readonly CatalogCard[]): OfferCandidate[] {
  const num = cleanCardNumber(read.cardNumber);
  const groups: OfferCandidate[][] = [[], [], [], []];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  // Clean entries first, so a listing never hides the clean card of the same facts.
  const ordered = [...cards].sort((a, b) => Number(isUnverified(a)) - Number(isUnverified(b)));
  for (const c of ordered) {
    if (seenIds.has(c.sourceId)) continue;
    if (read.sport && c.sport && c.sport !== read.sport) continue;
    if (isGroupCard(c)) continue;
    const cardNum = cleanCardNumber(c.cardNumber);
    if (read.player) {
      if (!playerAgrees(read.player, c.player)) continue;
    } else if (!num || cardNum !== num) {
      // No player read: only a card of the read number can be offered.
      continue;
    }
    const yearDiff = read.year != null && c.year != null && c.year !== read.year;
    const numDiff = num != null && cardNum != null && cardNum !== num;
    if (yearDiff && !unsureOf(read, "year")) continue;
    if (numDiff && !unsureOf(read, "cardNumber")) continue;
    const key = `${c.sport ?? ""}|${c.year ?? ""}|${normalizeBrand(`${c.brand ?? ""}${c.variation ?? ""}`)}|${normalizeText(c.setName ?? "")}|${cardNum ?? ""}|${normalizeName(c.player ?? "")}`;
    if (seenKeys.has(key)) continue;
    seenIds.add(c.sourceId);
    seenKeys.add(key);
    const differs = [
      yearDiff ? `The catalog says ${c.year}. The card reads ${read.year}.` : null,
      numDiff ? `The catalog says number ${cardNum}. The card reads ${num}.` : null,
    ].filter(Boolean).join(" ");
    const unverified = isUnverified(c);
    const offer: OfferCandidate = {
      ...c, verified: !unverified, score: 0, why: unverified ? "Unverified listing" : differs ? "Differs from the card" : "Agrees with the card",
      differs: differs || null,
    } as Candidate & { differs: string | null };
    groups[(unverified ? 2 : 0) + (differs ? 1 : 0)].push(offer);
  }
  return groups.flat().slice(0, MAX_STORED_CANDIDATES);
}

// ---------- C. the verified match ----------

/** The words of a catalog entry's product and set that the card does not read ("Tiffany", "Stained Glass"). */
function extraWords(read: Pick<FindRead, "brand" | "setName">, c: Pick<CatalogCard, "brand" | "variation" | "setName">): string[] {
  const have = new Set(normalizeText(`${read.brand ?? ""} ${read.setName ?? ""}`).split(" ").filter(Boolean));
  const theirs = normalizeText(`${c.brand ?? ""} ${c.variation ?? ""} ${(c.setName ?? "").replace(/^base set\b/i, "")}`).split(" ").filter(Boolean);
  return theirs.filter((w) => !have.has(w));
}

/** The catalog's maker or product agrees with the card's: a read product must be in the catalog's product. */
export function brandAgrees(read: Pick<FindRead, "brand" | "setName">, c: Pick<CatalogCard, "brand" | "variation" | "setName">): boolean {
  if (!read.brand && !read.setName) return false;
  const product = productOf(read.brand, read.setName);
  const theirs = normalizeBrand(`${c.brand ?? ""}${c.variation ?? ""}${c.setName ?? ""}`);
  if (product && read.setName && normalizeBrand(product) === normalizeBrand(read.setName)) {
    // A product was read ("Prizm", "Topps Chrome"): the catalog's entry must be of that product.
    return theirs.includes(normalizeBrand(product)) || normalizeBrand(`${c.brand ?? ""}${c.variation ?? ""}`).includes(normalizeBrand(product));
  }
  return Boolean(read.brand && c.brand && normalizeBrand(c.brand) === normalizeBrand(read.brand));
}

/**
 * C: a clean entry (not an unverified listing) whose player, card number and
 * year agree with what the card reads (number and year exactly as read), and
 * whose maker or product agrees. Never with a year taken from the stat rows,
 * and never on a value that did not come from the card or the owner.
 */
export function isVerifiedMatch(read: FindRead, c: OfferCandidate): boolean {
  if (isUnverified(c) || c.differs) return false;
  if (!read.player || read.year == null || read.yearFromStats) return false;
  // A value the catalog (or another list) gave can never confirm itself.
  const notRead = read.notRead ?? [];
  if (notRead.includes("player") || notRead.includes("year") || notRead.includes("cardNumber")) return false;
  const own = { brand: notRead.includes("brand") ? null : read.brand, setName: notRead.includes("setName") ? null : read.setName };
  const num = cleanCardNumber(read.cardNumber);
  if (!num || cleanCardNumber(c.cardNumber) !== num) return false;
  if (c.year !== read.year) return false;
  if (read.sport && c.sport !== read.sport) return false;
  if (isGroupCard(c) || !playerAgrees(read.player, c.player)) return false;
  return brandAgrees(own, c);
}

/**
 * The one match to link, or null. Two or more matches are versions of one
 * card (base and a parallel): the owner chooses, except one plain base entry
 * with known premium versions of it, where the base is linked and the version
 * question stays open (`assumedBase`). A single match that is a
 * version the card does not name (only "Topps Tiffany" came back for a read
 * "Topps") is not linked either.
 */
export function pickMatch(read: FindRead, offers: readonly OfferCandidate[]): { match: OfferCandidate | null; matches: number; assumedBase?: boolean } {
  const all = offers.filter((c) => isVerifiedMatch(read, c));
  if (all.length >= 2) {
    // One plain base entry plus premium versions of the same card: the base is linked, the version question stays open.
    const group = baseWithVersions(read, all, [read.variation ?? "", read.brand ?? "", read.setName ?? ""]);
    if (group && extraWords(read, group.base).length === 0) return { match: group.base, matches: all.length, assumedBase: true };
  }
  if (all.length !== 1) return { match: null, matches: all.length };
  const only = all[0];
  return { match: extraWords(read, only).length === 0 ? only : null, matches: 1 };
}

// ---------- the look up ----------

export type FindOptions = { catalog?: Catalog; scan?: ScanBudget };

/** The read card in the catalog: A, B, C and D. Never throws for a catalog failure. */
export async function findCard(read: FindRead, line: Line, options: FindOptions = {}): Promise<FindResult> {
  const catalog = options.catalog ?? createMyCardfolio();
  const scan = options.scan ?? createScanBudget();
  let callsUsed = 0;
  let stopped: FindStop | null = scan.stopped;
  const halted = () => stopped !== null && stopped !== "failed";

  async function spend<T>(call: (limits: CallLimits) => Promise<CatalogResult<T>>): Promise<T | null> {
    if (scan.stopped) stopped = scan.stopped;
    if (halted()) return null;
    const room = Math.min(FIND_CALLS - callsUsed, scan.max - scan.used);
    if (room <= 0) {
      stopped = "budget";
      return null;
    }
    const res = await call({ maxTries: Math.min(MAX_TRIES, room) });
    const fallback = res.ok ? (res.fromStore ? 0 : 1) : res.reason === "failed" ? 1 : 0;
    const told = Number(res.tries);
    const tries = Number.isFinite(told) && told >= 0 ? Math.trunc(told) : fallback;
    callsUsed += tries;
    scan.used += tries;
    if (res.ok) return res.value;
    stopped = res.reason;
    if (res.reason !== "failed") scan.stopped = res.reason;
    return null;
  }

  const seen: CatalogCard[] = [];
  async function search(q: FindQuery): Promise<void> {
    const key = `${q.sport ?? ""}|${q.year ?? ""}|${SEARCH_LIMIT}|${q.text.toLowerCase()}`;
    let cards = scan.searches.get(key) ?? null;
    if (!cards) {
      const ask: { text: string; limit: number; sport?: Sport; year?: number } = { text: q.text, limit: SEARCH_LIMIT };
      if (q.sport) ask.sport = q.sport;
      if (q.year != null) ask.year = q.year;
      const got = await spend((limits) => catalog.search(ask, line, limits));
      if (got) scan.searches.set(key, got);
      cards = got ?? [];
    }
    for (const c of cards) if (!seen.some((s) => s.sourceId === c.sourceId)) seen.push(c);
  }

  // A: the searches, stopping as soon as the card is found.
  for (const q of buildQueries(read)) {
    if (halted()) break;
    await search(q);
    const offers = offerCandidates(read, seen);
    if (pickMatch(read, offers).matches > 0) break;
    // A clean card of the read player was found: a search without the number adds only other cards.
    if (offers.some((c) => c.verified && !c.differs)) break;
  }

  let candidates = offerCandidates(read, seen);
  const fills: ChecklistFill[] = [];
  const notes: string[] = [];
  const { match, matches } = pickMatch(read, candidates);

  // D: the set's checklist for a missing or unsure player, or a missing number.
  if (!match && matches === 0 && !halted()) {
    const got = await checklistStep(read, seen, (id) => spend((limits) => catalog.checklist(id, line, limits)));
    if (got) {
      fills.push(...got.fills);
      notes.push(...got.notes);
      if (got.row) {
        const row = { ...got.row, score: 0, why: "From the set's checklist", differs: null } as OfferCandidate;
        candidates = [row, ...candidates.filter((c) => c.sourceId !== row.sourceId)].slice(0, MAX_STORED_CANDIDATES);
      }
    }
  }
  if (match) candidates = [match, ...candidates.filter((c) => c.sourceId !== match.sourceId)];
  return { candidates, match, matches, fills, notes, callsUsed, stopped };
}

// ---------- D. the checklist ----------

function teamsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeText(a ?? "");
  const y = normalizeText(b ?? "");
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/** When the checklist is asked: a sure year and maker or product, and a number with no trustworthy player, or a player with no number. */
export function wantsChecklist(read: FindRead): "number_to_player" | "player_to_number" | null {
  if (read.year == null || read.yearFromStats || unsureOf(read, "year")) return null;
  const brandSure = (read.brand && !unsureOf(read, "brand")) || (read.setName && !unsureOf(read, "setName"));
  if (!brandSure) return null;
  const num = cleanCardNumber(read.cardNumber);
  const playerTrusted = Boolean(read.player) && !unsureOf(read, "player");
  if (num && !playerTrusted) return "number_to_player";
  if (read.player && !num) return "player_to_number";
  return null;
}

/** The base set id of the read year and maker or product, from clean answers. Null when none or more than one. */
export function baseSetIdOf(read: FindRead, cards: readonly CatalogCard[]): string | null {
  const ids = new Set<string>();
  for (const c of cards) {
    if (!c.verified || isUnverified(c) || c.year !== read.year || c.variation || c.setName || !c.sourceSetId) continue;
    if (read.sport && c.sport !== read.sport) continue;
    if (setIdFromUrl(c.url) !== c.sourceSetId || !brandAgrees(read, c)) continue;
    ids.add(c.sourceSetId);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

export async function checklistStep(
  read: FindRead,
  seen: readonly CatalogCard[],
  fetchChecklist: (setId: string) => Promise<{ cards: CatalogCard[]; complete: boolean } | null>,
): Promise<{ fills: ChecklistFill[]; notes: string[]; row: CatalogCard | null } | null> {
  const want = wantsChecklist(read);
  if (!want) return null;
  const setId = baseSetIdOf(read, seen);
  if (!setId) return null;
  const list = await fetchChecklist(setId);
  if (!list) return null;
  const rows = list.cards.filter((c) => c.sourceSetId === setId && !isGroupCard(c) && c.player);
  const fills: ChecklistFill[] = [];
  const notes: string[] = [];
  if (want === "number_to_player") {
    const num = cleanCardNumber(read.cardNumber);
    const hits = rows.filter((c) => cleanCardNumber(c.cardNumber) === num);
    if (hits.length !== 1) return null;
    const row = hits[0];
    if (read.team && !unsureOf(read, "team") && row.team && !teamsAgree(read.team, row.team)) {
      notes.push(`The catalog's set list has number ${num} with the team ${row.team}. The card reads ${read.team}, so nothing was changed.`);
      return { fills, notes, row: null };
    }
    if (read.player) {
      if (playerAgrees(read.player, row.player)) {
        // The checklist is the second sign for the read name.
        fills.push({ field: "player", value: read.player, sure: true });
        notes.push(`The catalog's set list confirms number ${num} is ${row.player}.`);
      } else {
        notes.push(`The catalog's set list has ${row.player} as number ${num}. The card reads ${read.player}. Check the name.`);
        return { fills, notes, row: null };
      }
    } else {
      const sure = teamsAgree(read.team, row.team);
      fills.push({ field: "player", value: row.player!, sure });
      notes.push(`Player filled from the catalog's set list for number ${num}: ${row.player}. Check it.`);
    }
    if (!read.team && row.team) fills.push({ field: "team", value: row.team, sure: false });
    return { fills, notes, row };
  }
  const hits = rows.filter((c) => playerAgrees(read.player, c.player) && cleanCardNumber(c.cardNumber));
  if (hits.length !== 1) {
    if (hits.length > 1) notes.push(`The catalog's set list has ${hits.length} cards of ${read.player}, so the number was left empty.`);
    return { fills, notes, row: null };
  }
  const row = hits[0];
  if (read.team && !unsureOf(read, "team") && row.team && !teamsAgree(read.team, row.team)) {
    notes.push(`The catalog's set list has ${row.player} with the team ${row.team}. The card reads ${read.team}, so nothing was changed.`);
    return { fills, notes, row: null };
  }
  fills.push({ field: "cardNumber", value: cleanCardNumber(row.cardNumber)!, sure: teamsAgree(read.team, row.team) });
  notes.push(`Card number filled from the catalog's set list: ${cleanCardNumber(row.cardNumber)}. Check it.`);
  if (!read.team && row.team) fills.push({ field: "team", value: row.team, sure: false });
  return { fills, notes, row };
}
