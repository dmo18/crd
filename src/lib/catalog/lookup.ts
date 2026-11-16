import type { Sport } from "@/db/schema";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import type { Catalog, CatalogCard, CatalogFailure, Line } from "./types";
import { createMyCardfolio } from "./mycardfolio";
import { cleanCardNumber, setIdFromUrl, splitProduct } from "./clean";
import { normalizeBrand } from "./normalize";
import { MAX_CANDIDATES, judge, matchRead, slimRows, type Candidate, type Judgement, type MatchRead, type SlimRow } from "./match";

/**
 * The look up of one read card in the catalog: spends calls, then lets
 * `match.ts` decide. Steps, budgets and rules: docs/PLAN.md, Milestone 10,
 * "Design: matching done by Card Vault".
 */

/** What the reader found. */
export type LookupRead = {
  year: number | null;
  /** True when the year came only from the last stat row: the set of the year before is tried too. */
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
  /** Outside calls made for this card (stored answers do not count). */
  callsUsed: number;
  /** Why the look up stopped before its end, if it did. */
  stopped: LookupStop | null;
};

export const CARD_CALLS = 8;
export const SCAN_CALLS = 40;
/** Applied without a read number: waits in Review with the card filled in. */
export const CHECK_CONFIDENCE = 0.7;
/** Small answers only: a search with limit 50 took 7 s in the probe. */
const SEARCH_LIMIT = 10;
const MAX_SETS = 2;
/**
 * Cold start (no set id known yet): "year brand 1", then "year brand 2", each
 * with limit 5, until a clean Base Set card teaches the set id. At most 2
 * calls, inside the card's budget.
 */
const DISCOVERY_NUMBERS = ["1", "2"] as const;
const DISCOVERY_LIMIT = 5;

/** One per scan (a photo with many cards): the 40 call budget and what was learned on the way. */
export type ScanBudget = {
  used: number;
  max: number;
  /** off, paused or cap: no more calls for the rest of the scan. */
  stopped: CatalogFailure | null;
  /** "1990|topps" to the base set id, learned from clean answers. */
  setIds: Map<string, string>;
};

export function createScanBudget(max = SCAN_CALLS): ScanBudget {
  return { used: 0, max, stopped: null, setIds: new Map() };
}

/** The last 4 checklists as slim rows, so the second card of a set costs no call. */
export class ChecklistMemory {
  private sets = new Map<string, { key: string; cards: CatalogCard[]; complete: boolean }>();
  constructor(private readonly size = 4) {}
  get(setId: string) {
    const v = this.sets.get(setId);
    if (v) {
      this.sets.delete(setId);
      this.sets.set(setId, v);
    }
    return v ?? null;
  }
  put(setId: string, key: string, cards: CatalogCard[], complete: boolean) {
    this.sets.delete(setId);
    this.sets.set(setId, { key, cards, complete });
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

const memoryHolder = globalThis as unknown as { __crdChecklistMemory?: ChecklistMemory };
export function checklistMemory(): ChecklistMemory {
  memoryHolder.__crdChecklistMemory ??= new ChecklistMemory();
  return memoryHolder.__crdChecklistMemory;
}

export type LookupOptions = { catalog?: Catalog; scan?: ScanBudget; memory?: ChecklistMemory };

/** Confidence for the item: sure by number and name is filed as sure; applied without a number waits in Review. */
export function lookupConfidence(result: Pick<LookupResult, "sure" | "sureBy">, readingConfidence: number): number {
  if (result.sure && result.sureBy === "number") return Math.max(readingConfidence, REVIEW_THRESHOLD);
  if (result.sure) return CHECK_CONFIDENCE;
  return readingConfidence;
}

function setKey(year: number, brand: string): string {
  return `${year}|${normalizeBrand(brand)}`;
}

function cleanRead(read: LookupRead) {
  const year = Number.isInteger(read.year) && (read.year as number) >= 1800 && (read.year as number) <= 2100 ? (read.year as number) : null;
  // "Topps Tiffany" read: the brand is Topps (sets are found by brand), the product is kept to judge versions.
  const brands: string[] = [];
  const products: string[] = [];
  for (const b of (read.brands ?? []).slice(0, 2)) {
    const t = String(b ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const brand = splitProduct(t).brand;
    if (!brand || !normalizeBrand(brand)) continue;
    products.push(normalizeBrand(t));
    if (!brands.some((x) => normalizeBrand(x) === normalizeBrand(brand))) brands.push(brand);
  }
  const names: string[] = [];
  for (const n of read.names ?? []) {
    const t = String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (t.length >= 2 && !names.includes(t)) names.push(t);
  }
  return { year, yearFromStats: Boolean(read.yearFromStats), brands, products, tiffany: products.some((p) => p.includes("tiffany")), sport: read.sport ?? null, names: names.slice(0, 5), number: cleanCardNumber(read.cardNumber) };
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

export async function lookupCard(read: LookupRead, line: Line, options: LookupOptions = {}): Promise<LookupResult> {
  const catalog = options.catalog ?? createMyCardfolio();
  const scan = options.scan ?? createScanBudget();
  const memory = options.memory ?? checklistMemory();
  const r = cleanRead(read);
  const m: MatchRead = matchRead(r.names, r.number);
  const brandKeys = r.products;
  let callsUsed = 0;
  let stopped: LookupStop | null = scan.stopped;
  const done = (j: Pick<Judgement, "sure" | "sureBy">, candidates: Candidate[]): LookupResult => {
    const list = j.sure ? mergeCandidates([j.sure], candidates) : candidates;
    // A Tiffany read is a version question (Milestone 11): candidates only.
    const sure = r.tiffany ? null : j.sure;
    return { sure, sureBy: sure ? j.sureBy : null, candidates: list, callsUsed, stopped };
  };
  const nothing: Pick<Judgement, "sure" | "sureBy"> = { sure: null, sureBy: null };

  /** One outside call within the budgets. Null when it was not made or failed. */
  async function spend<T>(call: () => Promise<{ ok: true; value: T; fromStore: boolean } | { ok: false; reason: CatalogFailure }>): Promise<T | null> {
    if (stopped && stopped !== "failed") return null;
    if (callsUsed >= CARD_CALLS || scan.used >= scan.max) {
      stopped = "budget";
      return null;
    }
    const res = await call();
    if (res.ok) {
      if (!res.fromStore) {
        callsUsed++;
        scan.used++;
      }
      return res.value;
    }
    if (res.reason === "failed") {
      // The call went out and failed; the next step may still work.
      callsUsed++;
      scan.used++;
      stopped = "failed";
      return null;
    }
    stopped = res.reason;
    if (res.reason !== "busy") scan.stopped = res.reason;
    return null;
  }

  const searched = new Map<string, CatalogCard[]>();
  const noise: CatalogCard[] = [];
  /** `forCard`: the words were this card's name or number (a set id search gives no candidates). */
  async function search(text: string, year: number | null, forCard: boolean, limit = SEARCH_LIMIT): Promise<CatalogCard[]> {
    const key = text.toLowerCase();
    const known = searched.get(key);
    if (known) return known;
    const q: { text: string; limit: number; sport?: Sport; year?: number } = { text, limit };
    if (r.sport) q.sport = r.sport;
    if (year) q.year = year;
    const cards = (await spend(() => catalog.search(q, line))) ?? [];
    searched.set(key, cards);
    if (forCard) for (const c of cards) if (!c.verified && !noise.some((n) => n.sourceId === c.sourceId)) noise.push(c);
    // Base set ids come only from a clean, verified Base Set card, read from its url
    // (the probe: a broad search gives none; a Tiffany or insert card is another set).
    for (const c of cards) {
      if (c.verified && c.sourceSetId && c.year && c.brand && !c.variation && !c.setName && setIdFromUrl(c.url) === c.sourceSetId) {
        const k = setKey(c.year, c.brand);
        if (!scan.setIds.has(k)) scan.setIds.set(k, c.sourceSetId);
      }
    }
    return cards;
  }

  function rowsOf(cards: CatalogCard[], year: number | null, brandKey: string | null): SlimRow[] {
    const fit = cards.filter(
      (c) => c.verified && (year === null || c.year === year) && (brandKey === null || (c.brand !== null && normalizeBrand(c.brand) === brandKey)) && (!r.sport || !c.sport || c.sport === r.sport),
    );
    return slimRows(fit, brandKeys);
  }
  /** Unverified listings, for Review only, never judged by spelling. */
  function noiseCandidates(): Candidate[] {
    return noise.slice(0, 3).map((c) => ({ ...c, score: 0, why: "Unverified listing" }));
  }

  // ---- Step 3: year or brand unknown. No checklist is fetched.
  if (r.year === null || r.brands.length === 0) {
    const full = r.names[0];
    if (!full) return done(nothing, []);
    const text = r.year !== null ? `${r.year} ${full}` : r.brands.length > 0 ? `${r.brands[0]} ${full}` : full;
    const cards = await search(text, r.year, true);
    const rows = rowsOf(cards, r.year, r.brands[0] ? normalizeBrand(r.brands[0]) : null);
    // Applied only when exactly one clean entry agrees with a read number and the name.
    const j = judge(rows, m, false);
    return done(j, mergeCandidates(j.candidates, noiseCandidates()));
  }

  const year = r.year;
  // The sets to try: two possible brands, or one brand in the year and the year before.
  const targets: { year: number; brand: string }[] = r.brands.map((brand) => ({ year, brand }));
  if (targets.length < MAX_SETS && r.yearFromStats) targets.push({ year: year - 1, brand: r.brands[0] });
  const knownSetId = (t: { year: number; brand: string }) => scan.setIds.get(setKey(t.year, t.brand)) ?? memory.setIdFor(setKey(t.year, t.brand));

  // ---- Before any call: checklists already in memory (the second card of a set costs nothing).
  const inMemory: SlimRow[] = [];
  for (const t of targets) {
    const id = knownSetId(t);
    const set = id ? memory.get(id) : null;
    if (set) inMemory.push(...slimRows(set.cards, brandKeys));
  }
  if (inMemory.length > 0) {
    const j = judge(inMemory, m, true);
    if (j.sure) return done(j, j.candidates);
  }

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
    const j = judge(step1, m, false);
    if (j.sure) return done(j, j.candidates);
    if (stopped && stopped !== "failed") break;
  }
  const step1Judged = judge(step1, m, false);

  // ---- Step 2: checklist and close spelling, at most 2 sets.
  const pool: SlimRow[] = [];
  let fetchedAny = false;
  for (const t of targets.slice(0, MAX_SETS)) {
    if (stopped && stopped !== "failed") break;
    let id = knownSetId(t);
    for (const n of DISCOVERY_NUMBERS) {
      if (id || (stopped && stopped !== "failed")) break;
      await search(`${t.year} ${t.brand} ${n}`, t.year, false, DISCOVERY_LIMIT);
      id = knownSetId(t);
    }
    if (!id) continue;
    let set = memory.get(id);
    if (!set) {
      const setId = id;
      const got = await spend(() => catalog.checklist(setId, line));
      if (got) {
        memory.put(setId, setKey(t.year, t.brand), got.cards, got.complete);
        set = memory.get(setId);
      }
    }
    if (!set) continue;
    fetchedAny = true;
    pool.push(...slimRows(set.cards, brandKeys));
    // The checklist stops at 500 cards: one search by year, brand and number.
    if (!set.complete && r.number && !set.cards.some((c) => c.cardNumber === r.number)) {
      const extra = await search(`${t.year} ${t.brand} ${r.number}`, t.year, true);
      pool.push(...rowsOf(extra, t.year, normalizeBrand(t.brand)));
    }
  }
  if (fetchedAny) {
    const j = judge(pool, m, true);
    return done(j, mergeCandidates(j.candidates, step1Judged.candidates, noiseCandidates()));
  }
  return done(nothing, mergeCandidates(step1Judged.candidates, noiseCandidates()));
}
