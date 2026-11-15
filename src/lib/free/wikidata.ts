import { eq, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { playerFacts, SPORTS, type Sport } from "@/db/schema";
import { errorKind, log } from "@/lib/log";

/**
 * Player facts from Wikidata: free, no key, API use allowed.
 * Only two hosts are ever called. A failure returns null and never throws,
 * so a scan never depends on this service being up.
 */

const API_URL = "https://www.wikidata.org/w/api.php";
const SPARQL_URL = "https://query.wikidata.org/sparql";
/** Wikimedia asks every client to name a way to contact its operator. */
const DEFAULT_CONTACT = "https://github.com/dmo18/crd";
const MAX_CANDIDATES = 7;
/** How long to pause after a 429 that gives no usable Retry-After, and the longest pause honoured. */
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60 * 1000;
export const CACHE_MS = 90 * 24 * 60 * 60 * 1000;
/** Old cache rows are deleted on the first cache write and then every this many writes. */
export const PRUNE_EVERY = 100;
const MIN_GAP_MS = 200;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TEAMS = 15;

export type PlayerFacts = {
  name: string;
  wikidataId: string;
  description: string | null;
  sports: Sport[];
  teams: string[];
  careerStart: number | null;
  careerEnd: number | null;
  hallOfFame: boolean;
  birthYear: number | null;
};

export type LookupOptions = {
  sport?: Sport | null;
  year?: number | null;
  fetchImpl?: typeof fetch;
  db?: Db;
  now?: Date;
  timeoutMs?: number;
};

export type RankQuery = { name: string; sport?: Sport | null; year?: number | null };

/**
 * The User-Agent sent to Wikidata, with a contact as Wikimedia's policy asks.
 * WIKIDATA_CONTACT may hold an email address or a web address; anything else
 * falls back to the project page.
 */
export function userAgent(): string {
  const raw = (process.env.WIKIDATA_CONTACT ?? "").trim();
  const email = /^[^\s@()<>,;"]+@[^\s@()<>,;"]+\.[A-Za-z]{2,}$/;
  const web = /^https?:\/\/[^\s()<>"]+$/;
  const contact = raw.length > 0 && raw.length <= 200 && (email.test(raw) || web.test(raw)) ? raw : DEFAULT_CONTACT;
  return `CardVault/1.0 (${contact}) personal sports card collection app`;
}

const SUFFIX_WORDS = ["jr", "sr", "ii", "iii", "iv"];

/** "jr" for "Ken Griffey Jr.", null when the name has no suffix. */
function suffixOf(name: string): string | null {
  const tokens = name.normalize("NFD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  const last = tokens[tokens.length - 1];
  return tokens.length > 1 && SUFFIX_WORDS.includes(last) ? last : null;
}

/** Lowercase, accents stripped, punctuation removed, "jr", "sr" and numerals dropped. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !SUFFIX_WORDS.includes(t))
    .join(" ");
}

function cacheKey(name: string, sport: Sport | null | undefined): string {
  return `${normalizeName(name)}|${sport ?? ""}`;
}

// ---------- sport and athlete mapping ----------

function mapSport(label: string): Sport | null {
  const l = label.toLowerCase();
  if (l.includes("association football") || l.includes("soccer")) return "soccer";
  if (l.includes("baseball")) return "baseball";
  if (l.includes("basketball")) return "basketball";
  if (l.includes("football")) return "football";
  if (l.includes("hockey")) return "hockey";
  if (l.includes("golf")) return "golf";
  if (l.includes("racing") || l.includes("motorsport")) return "racing";
  if (l.includes("wrestling")) return "wrestling";
  if (l.includes("boxing") || l.includes("boxer")) return "boxing";
  return null;
}

const ATHLETE_WORDS = /player|athlete|pitcher|quarterback|goaltender|goalkeeper|catcher|boxer|wrestler|golfer|racing driver|racer|sprinter|footballer|infielder|outfielder|running back|receiver|linebacker|defenseman/i;

// ---------- response shapes ----------

const searchSchema = z.object({
  search: z.array(z.object({ id: z.string().regex(/^Q\d{1,12}$/), label: z.string().optional() }).passthrough()).max(50),
});

const cell = z.object({ value: z.string() });
const rowSchema = z.object({
  item: cell,
  // Some well known people have no English label in the query service, so
  // the label is optional and the search result's label is used instead.
  label: cell.optional(),
  description: cell.optional(),
  sports: cell.optional(),
  teams: cell.optional(),
  occupations: cell.optional(),
  awards: cell.optional(),
  start: cell.optional(),
  end: cell.optional(),
  birth: cell.optional(),
});
const sparqlSchema = z.object({ results: z.object({ bindings: z.array(rowSchema).max(100) }) });

const factsSchema = z.object({
  name: z.string().max(120),
  wikidataId: z.string().max(20),
  description: z.string().max(300).nullable(),
  sports: z.array(z.string()).max(12),
  teams: z.array(z.string().max(80)).max(MAX_TEAMS),
  careerStart: z.number().int().nullable(),
  careerEnd: z.number().int().nullable(),
  hallOfFame: z.boolean(),
  birthYear: z.number().int().nullable(),
});

// ---------- parsing ----------

function list(v: string | undefined): string[] {
  if (!v) return [];
  return [...new Set(v.split("|").map((s) => s.trim()).filter(Boolean))];
}

function yearOf(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 3000 ? n : null;
}

function toFacts(row: z.infer<typeof rowSchema>, fallbackName?: string): PlayerFacts | null {
  const id = row.item.value.split("/").pop() ?? "";
  if (!/^Q\d{1,12}$/.test(id)) return null;
  const name = row.label?.value ?? fallbackName;
  if (!name) return null;
  const sportLabels = list(row.sports?.value);
  const occupations = list(row.occupations?.value);
  const isAthlete = sportLabels.length > 0 || occupations.some((o) => ATHLETE_WORDS.test(o));
  if (!isAthlete) return null;

  const sports: Sport[] = [];
  for (const label of [...sportLabels, ...occupations]) {
    const s = mapSport(label);
    if (s && !sports.includes(s)) sports.push(s);
  }
  const hallOfFame = list(row.awards?.value).some((award) => {
    if (!/hall of fame/i.test(award)) return false;
    // College and school halls of fame say nothing about a pro career.
    if (/college|collegiate|university|high school|ncaa|amateur/i.test(award)) return false;
    const s = mapSport(award);
    return s !== null && (sports.length === 0 || sports.includes(s));
  });

  return {
    name: name.slice(0, 120),
    wikidataId: id,
    description: row.description?.value ? row.description.value.slice(0, 300) : null,
    sports,
    teams: list(row.teams?.value).slice(0, MAX_TEAMS).map((t) => t.slice(0, 80)),
    careerStart: yearOf(row.start?.value),
    careerEnd: yearOf(row.end?.value),
    hallOfFame,
    birthYear: yearOf(row.birth?.value),
  };
}

// ---------- ranking ----------

/**
 * Order candidates best first and drop impossible ones: names that do not
 * match, and cards dated before the player turned 15. Pure, for tests.
 */
export function rankCandidates(candidates: PlayerFacts[], query: RankQuery): PlayerFacts[] {
  const want = normalizeName(query.name);
  const wantTokens = want.split(" ").filter(Boolean);
  if (wantTokens.length === 0) return [];
  const year = query.year ?? null;
  const wantSuffix = suffixOf(query.name);

  const scored: { c: PlayerFacts; score: number; order: number }[] = [];
  candidates.forEach((c, order) => {
    if (year !== null && c.birthYear !== null && year < c.birthYear + 15) return;
    const have = normalizeName(c.name);
    let score = 0;
    if (have === want) score += 100;
    else {
      const haveTokens = new Set(have.split(" "));
      if (wantTokens.every((t) => haveTokens.has(t))) score += 20;
      else return;
    }
    // "Jr." and "Sr." are different people: father and son often share a name and an era.
    const haveSuffix = suffixOf(c.name);
    if (wantSuffix && haveSuffix) {
      if (wantSuffix !== haveSuffix) return;
      score += 40;
    }
    if (query.sport) {
      if (c.sports.includes(query.sport)) score += 50;
      else if (c.sports.length > 0) score -= 40;
    }
    if (year !== null && c.careerStart !== null) {
      const covers = c.careerStart <= year + 1 && (c.careerEnd === null || c.careerEnd >= year - 1);
      score += covers ? 30 : -30;
    }
    if (c.hallOfFame) score += 5;
    scored.push({ c, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.c);
}

// ---------- polite network access ----------

let chain: Promise<unknown> = Promise.resolve();
let lastRequestEnd = 0;
/** After a 429, no requests until this time (ms since epoch). */
let pausedUntil = 0;

/** For tests only: forget an earlier "too many requests" pause. */
export function resetWikidataPause(): void {
  pausedUntil = 0;
}

function paused(): boolean {
  return Date.now() < pausedUntil;
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(value: string | null): number {
  if (value) {
    const v = value.trim();
    if (/^\d+$/.test(v)) return Math.min(MAX_PAUSE_MS, Math.max(1000, Number(v) * 1000));
    const at = Date.parse(v);
    if (Number.isFinite(at)) return Math.min(MAX_PAUSE_MS, Math.max(1000, at - Date.now()));
  }
  return DEFAULT_PAUSE_MS;
}

/** One job at a time across the process. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  if (paused()) throw Object.assign(new Error("paused"), { name: "RateLimited" });
  const wait = lastRequestEnd + MIN_GAP_MS - Date.now();
  if (wait > 0) await Promise.race([sleep(wait), aborted(signal)]);
  try {
    const res = await Promise.race([
      fetchImpl(url, { headers: { "User-Agent": userAgent(), Accept: "application/json" }, signal }),
      aborted(signal),
    ]);
    if (res.status === 429 || (res.status === 503 && res.headers.get("Retry-After"))) {
      pausedUntil = Date.now() + retryAfterMs(res.headers.get("Retry-After"));
      throw Object.assign(new Error("too many requests"), { name: "RateLimited" });
    }
    if (res.status !== 200) throw new Error("HttpError");
    return await Promise.race([res.json(), aborted(signal)]);
  } finally {
    lastRequestEnd = Date.now();
  }
}

function sparqlFor(ids: string[]): string {
  const values = ids.map((id) => `wd:${id}`).join(" ");
  return `SELECT ?item (SAMPLE(?l) AS ?label) (SAMPLE(?d) AS ?description)
  (GROUP_CONCAT(DISTINCT ?sl; separator="|") AS ?sports)
  (GROUP_CONCAT(DISTINCT ?tl; separator="|") AS ?teams)
  (GROUP_CONCAT(DISTINCT ?ol; separator="|") AS ?occupations)
  (GROUP_CONCAT(DISTINCT ?al; separator="|") AS ?awards)
  (MIN(YEAR(?ps)) AS ?start) (MAX(YEAR(?pe)) AS ?end) (MIN(YEAR(?dob)) AS ?birth)
WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item rdfs:label ?l . FILTER(LANG(?l) = "en") }
  OPTIONAL { ?item schema:description ?d . FILTER(LANG(?d) = "en") }
  OPTIONAL { ?item wdt:P641 ?s . ?s rdfs:label ?sl . FILTER(LANG(?sl) = "en") }
  OPTIONAL { ?item wdt:P54 ?t . ?t rdfs:label ?tl . FILTER(LANG(?tl) = "en") }
  OPTIONAL { ?item wdt:P106 ?o . ?o rdfs:label ?ol . FILTER(LANG(?ol) = "en") }
  OPTIONAL { ?item wdt:P166 ?a . ?a rdfs:label ?al . FILTER(LANG(?al) = "en") }
  OPTIONAL { ?item wdt:P2031 ?ps }
  OPTIONAL { ?item wdt:P2032 ?pe }
  OPTIONAL { ?item wdt:P569 ?dob }
}
GROUP BY ?item`;
}

async function fetchCandidates(name: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<PlayerFacts[]> {
  const search = new URLSearchParams({
    action: "wbsearchentities", search: name.slice(0, 120), language: "en", type: "item", limit: "7", format: "json",
  });
  const found = searchSchema.parse(await getJson(fetchImpl, `${API_URL}?${search}`, signal));
  const ids = found.search.map((s) => s.id);
  if (ids.length === 0) return [];

  const sparql = new URLSearchParams({ query: sparqlFor(ids), format: "json" });
  const data = sparqlSchema.parse(await getJson(fetchImpl, `${SPARQL_URL}?${sparql}`, signal));
  const byId = new Map<string, PlayerFacts>();
  for (const row of data.results.bindings) {
    const id = row.item.value.split("/").pop() ?? "";
    const facts = toFacts(row, found.search.find((s) => s.id === id)?.label);
    if (facts) byId.set(facts.wikidataId, facts);
  }
  // Keep Wikidata's own search order, which helps break ties.
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// ---------- public lookup ----------

/** Look up a player. Returns null when unknown, not an athlete, or the service is unavailable. */
export async function lookupPlayer(name: string, opts: LookupOptions = {}): Promise<PlayerFacts | null> {
  try {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const sport = opts.sport ?? null;
    const key = cacheKey(name, sport);
    const now = opts.now ?? new Date();
    const db = opts.db ?? getDb();
    const year = opts.year ?? null;
    const pick = (found: PlayerFacts[]) => rankCandidates(found, { name, sport, year })[0] ?? null;

    // The cache holds every candidate for this name and sport, so each card's
    // year and the name's suffix ("Jr.", "Sr.") pick between them again on a hit.
    const cached = readCache(db, key, now);
    if (cached !== undefined) return cached === null ? null : pick(cached);

    // Wikidata asked us to slow down: skip lookups until the pause ends.
    if (paused()) return null;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const candidates = await enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchCandidates(name, fetchImpl, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    });

    // Cache every candidate whose name matches, then apply this card's year.
    const keep = rankCandidates(candidates, { name: normalized, sport }).slice(0, MAX_CANDIDATES);
    writeCache(db, key, keep.length ? keep : null, now);
    return pick(keep);
  } catch (e) {
    log.warn("wikidata_lookup_failed", { error: errorKind(e) });
    return null;
  }
}

/**
 * undefined means "not cached or too old"; null means a cached miss.
 * Rows from before candidates were cached hold a single object and are fetched again.
 */
function readCache(db: Db, key: string, now: Date): PlayerFacts[] | null | undefined {
  try {
    const row = db.select().from(playerFacts).where(eq(playerFacts.key, key)).get();
    if (!row) return undefined;
    if (now.getTime() - row.fetchedAt.getTime() >= CACHE_MS) return undefined;
    if (row.facts === null) return null;
    const parsed = z.array(factsSchema).min(1).max(MAX_CANDIDATES).parse(JSON.parse(row.facts));
    return parsed.map((p) => ({ ...p, sports: p.sports.filter((s): s is Sport => (SPORTS as readonly string[]).includes(s)) }));
  } catch {
    return undefined;
  }
}

/** Deletes cached facts older than the 90 day cache window. Returns how many were removed. */
export function prunePlayerFacts(db: Db = getDb(), now: Date = new Date()): number {
  return db.delete(playerFacts).where(lt(playerFacts.fetchedAt, new Date(now.getTime() - CACHE_MS))).run().changes;
}

const counter = globalThis as unknown as { __crdFactWrites?: number };

/** For tests only: makes the next cache write prune. */
export function resetFactsPruneCounter(): void {
  counter.__crdFactWrites = 0;
}

function writeCache(db: Db, key: string, facts: PlayerFacts[] | null, now: Date) {
  try {
    counter.__crdFactWrites = ((counter.__crdFactWrites ?? 0) + 1) % PRUNE_EVERY;
    if (counter.__crdFactWrites === 1) prunePlayerFacts(db, now);
    const json = facts ? JSON.stringify(facts) : null;
    db.insert(playerFacts)
      .values({ key, facts: json, fetchedAt: now })
      .onConflictDoUpdate({ target: playerFacts.key, set: { facts: json, fetchedAt: now } })
      .run();
  } catch {
    // A cache write problem must not break a scan.
  }
}
