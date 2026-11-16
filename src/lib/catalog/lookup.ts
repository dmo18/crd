import type { Sport } from "@/db/schema";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import type { CallLimits, Catalog, CatalogCard, CatalogFailure, CatalogResult, Line } from "./types";
import { createMyCardfolio } from "./mycardfolio";
import { cleanCardNumber, setIdFromUrl, splitProduct } from "./clean";
import { normalizeBrand } from "./normalize";
import { MAX_CANDIDATES, judge, matchRead, slimRows, type Candidate, type Judgement, type MatchRead, type SlimRow, type SureGate } from "./match";

/**
 * The look up of one read card in the catalog: spends calls, then lets
 * `match.ts` decide. Steps, budgets and rules: docs/PLAN.md, Milestone 10,
 * "Design: matching done by Card Vault".
 */

/** What the reader found. */
export type LookupRead = {
  year: number | null;
  /** True when the year came only from the last stat row: the set of the year before is tried too, and nothing is sure. */
  yearFromStats?: boolean;
  /** Up to 2 possible brands, the likeliest first. */
  brands: string[];
  sport: Sport | null;
  /** Up to 5 name spellings, the likeliest first. */
  names: string[];
  cardNumber: string | null;
};

export type LookupStop = "budget" | CatalogFailure;

export type LookupResult = {
  /** Applied by the app. Never a Tiffany or other special product, never an unverified listing. */
  sure: Candidate | null;
  sureBy: Judgement["sureBy"];
  /** Up to 5, best first, for Review. */
  candidates: Candidate[];
  /** Network tries made for this card: a call the gate tried again counts each try; stored answers count 0. */
  callsUsed: number;
  /** Why the look up stopped before its end, if it did. */
  stopped: LookupStop | null;
};

export const CARD_CALLS = 8;
export const SCAN_CALLS = 40;
/** Small answers only: a search with limit 50 took 7 s in the probe. */
const SEARCH_LIMIT = 10;
const MAX_SETS = 2;
/** Catalog calls from a scan: the first try and at most one retry. */
const MAX_TRIES = 2;
/**
 * Cold start (no set id known yet): "year brand 1", then "year brand 2", each
 * with limit 5, until a clean Base Set card teaches the set id. At most 2
 * calls, inside the card's budget.
 */
const DISCOVERY_NUMBERS = ["1", "2"] as const;
const DISCOVERY_LIMIT = 5;

/**
 * The last 4 checklists of one scan, so the second card of a set costs no
 * call. Kept as slim rows: each checklist is parsed once per scan.
 */
export class ChecklistMemory {
  private sets = new Map<string, { key: string; rows: SlimRow[]; complete: boolean }>();
  constructor(private readonly size = 4) {}
  /** Without changing the order. */
  peek(setId: string) {
    return this.sets.get(setId) ?? null;
  }
  get(setId: string) {
    const v = this.sets.get(setId);
    if (v) {
      this.sets.delete(setId);
      this.sets.set(setId, v);
    }
    return v ?? null;
  }
  /** `key`: sport, year and brand (see `setKey`). */
  put(setId: string, key: string, cards: readonly CatalogCard[], complete: boolean) {
    this.sets.delete(setId);
    this.sets.set(setId, { key, rows: slimRows(cards), complete });
    while (this.sets.size > this.size) this.sets.delete(this.sets.keys().next().value as string);
  }
  setIdFor(key: string): string | null {
    for (const [id, v] of this.sets) if (v.key === key) return id;
    return null;
  }
  clear() {
    this.sets.clear();
  }
}

/**
 * One per scan (a photo with many cards): the 40 call budget and what was
 * learned on the way. Everything remembered lives here and ends with the
 * scan; between scans only the gate's stored answers remain. There is no
 * map that outlives a scan.
 */
export type ScanBudget = {
  used: number;
  max: number;
  /** off, paused, cap or busy: no more catalog calls for the rest of the scan. */
  stopped: CatalogFailure | null;
  /** "baseball|1990|topps" to the base set id, learned from clean answers of that sport. */
  setIds: Map<string, string>;
  /**
   * Keys for which a second clean set id showed up in any answer: nothing of
   * that sport, year and brand is sure for the rest of the scan.
   */
  conflicts: Set<string>;
  /** Checklists fetched in this scan. */
  memory: ChecklistMemory;
  /** Search answers of this scan, so the same words are never asked twice. */
  searches: Map<string, CatalogCard[]>;
};

export function createScanBudget(max = SCAN_CALLS): ScanBudget {
  return { used: 0, max, stopped: null, setIds: new Map(), conflicts: new Set(), memory: new ChecklistMemory(), searches: new Map() };
}

export type LookupOptions = { catalog?: Catalog; scan?: ScanBudget };

/** Confidence for the item: a sure card is filed as sure; anything else keeps the reading's confidence. */
export function lookupConfidence(result: Pick<LookupResult, "sure" | "sureBy">, readingConfidence: number): number {
  if (result.sure && result.sureBy === "number") return Math.max(readingConfidence, REVIEW_THRESHOLD);
  return readingConfidence;
}

/** The sport is part of the key: 1990 Topps baseball and 1990 Topps football are two sets. */
export function setKey(sport: Sport, year: number, brand: string): string {
  return `${sport}|${year}|${normalizeBrand(brand)}`;
}

function cleanRead(read: LookupRead) {
  const year = Number.isInteger(read.year) && (read.year as number) >= 1800 && (read.year as number) <= 2100 ? (read.year as number) : null;
  // "Topps Tiffany" read: the brand is Topps (sets are found by brand). A variation is never applied, even when read.
  const brands: string[] = [];
  let tiffany = false;
  for (const b of (read.brands ?? []).slice(0, 2)) {
    const t = String(b ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const brand = splitProduct(t).brand;
    if (!brand || !normalizeBrand(brand)) continue;
    if (normalizeBrand(t).includes("tiffany")) tiffany = true;
    if (!brands.some((x) => normalizeBrand(x) === normalizeBrand(brand))) brands.push(brand);
  }
  const names: string[] = [];
  for (const n of read.names ?? []) {
    const t = String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (t.length >= 2 && !names.includes(t)) names.push(t);
  }
  return { year, yearFromStats: Boolean(read.yearFromStats), brands, tiffany, sport: read.sport ?? null, names: names.slice(0, 5), number: cleanCardNumber(read.cardNumber) };
}

function surnameOf(name: string): string | null {
  const words = name.replace(/[,.]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^(jr|sr|ii|iii|iv|j|s)$/i.test(words[words.length - 1])) words.pop();
  return words.length >= 2 ? words[words.length - 1] : null;
}

function mergeCandidates(...lists: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of lists.flat().sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score)) {
    if (!out.some((o) => o.sourceId === c.sourceId)) out.push(c);
  }
  return out.slice(0, MAX_CANDIDATES);
}

type Target = { year: number; brand: string };
type FetchedSet = { target: Target; rows: SlimRow[]; complete: boolean };

export async function lookupCard(read: LookupRead, line: Line, options: LookupOptions = {}): Promise<LookupResult> {
  const catalog = options.catalog ?? createMyCardfolio();
  const scan = options.scan ?? createScanBudget();
  const memory = scan.memory;
  const r = cleanRead(read);
  const sport = r.sport;
  const m: MatchRead = matchRead(r.names, r.number);
  let callsUsed = 0;
  let stopped: LookupStop | null = scan.stopped;
  // The card's own reading comes first (12R.4): a candidate whose year or
  // number disagrees with what was read on the card goes last, and an
  // unverified listing that disagrees is not offered at all.
  const disagrees = (c: Candidate) => {
    const year = r.year !== null && c.year !== null && c.year !== r.year && !(r.yearFromStats && c.year === r.year - 1);
    const number = m.number !== null && c.cardNumber !== null && cleanCardNumber(c.cardNumber) !== m.number;
    return year || number;
  };
  const cardFirst = (list: Candidate[]) => [...list.filter((c) => !disagrees(c)), ...list.filter((c) => disagrees(c) && c.verified)];
  const done = (j: Pick<Judgement, "sure" | "sureBy">, candidates: Candidate[]): LookupResult => {
    const list = cardFirst(j.sure ? mergeCandidates([j.sure], candidates) : candidates);
    // A Tiffany read is a version question (Milestone 11): candidates only.
    const sure = r.tiffany ? null : j.sure;
    return { sure, sureBy: sure ? j.sureBy : null, candidates: list, callsUsed, stopped };
  };
  const nothing: Pick<Judgement, "sure" | "sureBy"> = { sure: null, sureBy: null };
  const halted = () => stopped !== null && stopped !== "failed";

  /**
   * One outside call within the budgets. Null when it was not made or failed.
   * Every network try counts: the call may try at most twice, and never more
   * often than the budgets still allow.
   */
  async function spend<T>(call: (limits: CallLimits) => Promise<CatalogResult<T>>): Promise<T | null> {
    if (scan.stopped) stopped = scan.stopped;
    if (halted()) return null;
    const room = Math.min(CARD_CALLS - callsUsed, scan.max - scan.used);
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
    // A failed call went out and failed; the next step may still work.
    // off, paused, cap and busy stop catalog calls for the rest of the scan.
    stopped = res.reason;
    if (res.reason !== "failed") scan.stopped = res.reason;
    return null;
  }

  // Set ids learned from other cards are used only for the same sport. With
  // no sport read, only what this card's own searches taught is used.
  const setIds = sport ? scan.setIds : new Map<string, string>();
  const conflicts = sport ? scan.conflicts : new Set<string>();
  const keyOf = (t: Target) => setKey(sport ?? ("unknown" as Sport), t.year, t.brand);
  const sportFits = (c: CatalogCard) => !sport || c.sport === sport;

  const tried = new Map<string, CatalogCard[]>();
  const noise: CatalogCard[] = [];
  /** Every clean row of the read sport seen in this card's answers: who else carries the surname. */
  const seenRows: SlimRow[] = [];
  const seenIds = new Set<string>();
  /** `forCard`: the words were this card's name or number (a set id search gives no candidates). */
  async function search(text: string, year: number | null, forCard: boolean, limit = SEARCH_LIMIT): Promise<CatalogCard[]> {
    const key = `${sport ?? ""}|${year ?? ""}|${limit}|${text.toLowerCase()}`;
    let cards = tried.get(key) ?? scan.searches.get(key) ?? null;
    if (!cards) {
      const q: { text: string; limit: number; sport?: Sport; year?: number } = { text, limit };
      if (sport) q.sport = sport;
      if (year) q.year = year;
      const got = await spend((limits) => catalog.search(q, line, limits));
      if (got) scan.searches.set(key, got);
      cards = got ?? [];
    }
    tried.set(key, cards);
    const fresh = cards.filter((c) => c.verified && sportFits(c) && !seenIds.has(c.sourceId));
    for (const c of fresh) seenIds.add(c.sourceId);
    if (fresh.length > 0) seenRows.push(...slimRows(fresh));
    if (forCard) for (const c of cards) if (!c.verified && !noise.some((n) => n.sourceId === c.sourceId)) noise.push(c);
    // Base set ids come only from a clean, verified Base Set card of the read
    // sport, read from its url (the probe: a broad search gives none; a
    // Tiffany or insert card is another set).
    // A set id already known for the scan is kept for fetching. A second
    // clean set id for the same key, in this answer or any later one, marks
    // the conflict for the rest of the scan: nothing of it is sure. When the
    // first answer for a key already shows two, no base set is learned ("").
    const seen = new Map<string, Set<string>>();
    for (const c of cards) {
      if (c.verified && c.sourceSetId && c.year && c.brand && !c.variation && !c.setName && sportFits(c) && setIdFromUrl(c.url) === c.sourceSetId) {
        const k = keyOf({ year: c.year, brand: c.brand });
        const ids = seen.get(k) ?? new Set<string>();
        ids.add(c.sourceSetId);
        seen.set(k, ids);
      }
    }
    for (const [k, ids] of seen) {
      const known = setIds.get(k);
      if (known !== undefined) {
        if (known === "" || [...ids].some((id) => id !== known)) conflicts.add(k);
        continue;
      }
      if (ids.size > 1) conflicts.add(k);
      setIds.set(k, ids.size === 1 ? [...ids][0] : "");
    }
    return cards;
  }

  /** Clean rows of the read year, brand and sport. Nothing of another sport is ever judged. */
  function rowsOf(cards: CatalogCard[], year: number | null, brandKey: string | null): SlimRow[] {
    const fit = cards.filter(
      (c) => c.verified && (year === null || c.year === year) && (brandKey === null || (c.brand !== null && normalizeBrand(c.brand) === brandKey)) && sportFits(c),
    );
    return slimRows(fit);
  }
  /** Unverified listings, for Review only, never judged by spelling. */
  function noiseCandidates(): Candidate[] {
    return noise.slice(0, 3).map((c) => ({ ...c, score: 0, why: "Unverified listing" }));
  }

  // ---- Step 3: year or brand unknown. No checklist is fetched, and a search
  // answer here is a candidate only: nothing is sure without year and brand.
  if (r.year === null || r.brands.length === 0) {
    const full = r.names[0];
    if (!full) return done(nothing, []);
    const text = r.year !== null ? `${r.year} ${full}` : r.brands.length > 0 ? `${r.brands[0]} ${full}` : full;
    const cards = await search(text, r.year, true);
    const rows = rowsOf(cards, r.year, r.brands[0] ? normalizeBrand(r.brands[0]) : null);
    const j = judge(rows, m, null);
    return done(j, mergeCandidates(j.candidates, noiseCandidates()));
  }

  const year = r.year;
  // The sets to try: two possible brands, or one brand in the year and the year before.
  const targets: Target[] = r.brands.map((brand) => ({ year, brand })).slice(0, MAX_SETS);
  if (targets.length < MAX_SETS && r.yearFromStats) targets.push({ year: year - 1, brand: r.brands[0] });
  const knownSetId = (t: Target) => {
    const learned = setIds.get(keyOf(t));
    // A conflict between searches: only a checklist already held for this
    // scan can still say which set is the base set.
    if (learned === "") return sport ? memory.setIdFor(keyOf(t)) : null;
    return learned ?? (sport ? memory.setIdFor(keyOf(t)) : null);
  };
  /**
   * Sure is possible only with sport, year and brand read, exactly one brand
   * and one year tried, and a year not taken from stat rows.
   */
  const oneTarget = Boolean(sport) && r.brands.length === 1 && !r.yearFromStats && targets.length === 1;
  /**
   * The base set id confirmed by its fetched checklist (in this scan or from
   * stored answers): held in memory for this sport, year and brand, and every
   * row a plain Base Set card of them. A conflict for the key confirms nothing.
   */
  const confirmedId = (t: Target): string | null => {
    const k = keyOf(t);
    if (conflicts.has(k)) return null;
    const id = knownSetId(t);
    const set = id ? memory.peek(id) : null;
    if (!id || !set || set.key !== k || set.rows.length === 0) return null;
    const brandKey = normalizeBrand(t.brand);
    const base = set.rows.every(
      (row) =>
        row.card.sourceSetId === id && row.card.setName === null && !row.card.variation && row.card.year === t.year &&
        row.card.brand !== null && normalizeBrand(row.card.brand) === brandKey && row.card.sport === sport,
    );
    return base ? id : null;
  };
  /** What may make a card sure. Looked up at each judging: checklists and answers change it. */
  const gate = (extraRivals: readonly SlimRow[] = []): SureGate => {
    const id = oneTarget ? confirmedId(targets[0]) : null;
    return { baseSetIds: id ? [id] : [], rivals: [...seenRows, ...extraRivals] };
  };
  /**
   * Step 1 found a card that would be sure once its set is confirmed: the
   * learned set id, no conflict, everything else as for sure. Then step 1
   * stops and the checklist is fetched to confirm it.
   */
  const wouldBeSure = (rows: readonly SlimRow[]): boolean => {
    if (!oneTarget) return false;
    const k = keyOf(targets[0]);
    const id = setIds.get(k);
    if (!id || conflicts.has(k)) return false;
    return judge(rows, m, { baseSetIds: [id], rivals: seenRows }).sure !== null;
  };

  /**
   * The end of step 2: judges the fetched checklists together with the clean
   * rows step 1 found (`step1`). A checklist cut short gets one search by
   * year, brand and number for a read number past its end; no other search is
   * spent here. `oneSearch`: the checklists came from memory, so at most one
   * such search.
   */
  async function decide(sets: FetchedSet[], oneSearch: boolean, step1: readonly SlimRow[], others: Candidate[]): Promise<LookupResult> {
    const pool: SlimRow[] = [...step1];
    let searches = 0;
    for (const set of sets) {
      pool.push(...set.rows.filter((row) => sportFits(row.card)));
      // The checklist stops at 500 cards: one search by year, brand and number.
      if (!set.complete && r.number && !pool.some((row) => row.number === r.number) && !(oneSearch && searches > 0)) {
        searches++;
        const extra = await search(`${set.target.year} ${set.target.brand} ${r.number}`, set.target.year, true);
        pool.push(...rowsOf(extra, set.target.year, normalizeBrand(set.target.brand)));
      }
    }
    // Every checklist row tried is a possible rival, not only the read sport's year and brand rows judged.
    const j = judge(pool, m, gate(sets.flatMap((s) => s.rows)));
    return done(j, mergeCandidates(j.candidates, others, noiseCandidates()));
  }

  // ---- Before any call: checklists already in this scan's memory.
  const remembered: FetchedSet[] = [];
  for (const t of targets) {
    const id = knownSetId(t);
    const set = id ? memory.get(id) : null;
    if (set) remembered.push({ target: t, rows: set.rows, complete: set.complete });
  }
  // Every set to try is in memory: no step 1 searches are spent on this card.
  if (remembered.length === targets.length) return decide(remembered, true, [], []);

  // ---- Step 1: exact search, clean entries only, up to 3 calls.
  const brand = r.brands[0];
  const step1: SlimRow[] = [];
  const queries: string[] = [];
  const full = r.names[0];
  if (full) {
    queries.push(`${year} ${brand} ${full}`);
    const sur = surnameOf(full);
    if (sur && sur.toLowerCase() !== full.toLowerCase()) queries.push(`${year} ${brand} ${sur}`);
  }
  if (r.number) queries.push(`${year} ${brand} ${r.number}`);
  for (const text of queries) {
    step1.push(...rowsOf(await search(text, year, true), year, normalizeBrand(brand)));
    // Nothing is sure before its base set is confirmed by the checklist (step 2).
    if (wouldBeSure(step1)) break;
    if (halted()) break;
  }
  const step1Judged = judge(step1, m, null);

  // ---- Step 2: checklist and close spelling, at most 2 sets.
  const fetched: FetchedSet[] = [];
  for (const t of targets) {
    if (halted()) break;
    let id = knownSetId(t);
    for (const n of DISCOVERY_NUMBERS) {
      if (id || halted()) break;
      await search(`${t.year} ${t.brand} ${n}`, t.year, false, DISCOVERY_LIMIT);
      id = knownSetId(t);
    }
    if (!id) continue;
    let set = memory.get(id);
    if (!set) {
      const setId = id;
      const got = await spend((limits) => catalog.checklist(setId, line, limits));
      if (got) {
        memory.put(setId, keyOf(t), got.cards, got.complete);
        set = memory.get(setId);
      }
    }
    if (set) fetched.push({ target: t, rows: set.rows, complete: set.complete });
  }
  if (fetched.length > 0) return decide(fetched, false, step1, step1Judged.candidates);
  return done(nothing, mergeCandidates(step1Judged.candidates, noiseCandidates()));
}
