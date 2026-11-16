import type { CatalogCard } from "./types";
import { cleanCardNumber } from "./clean";
import { normalizeName } from "./normalize";

/**
 * Matching done by Card Vault (the site forgives no spelling mistake).
 * Pure and cheap: no calls, no clock. Rules: docs/PLAN.md, Milestone 10,
 * "Design: matching done by Card Vault", "Close-spelling rule".
 */

// ---------- names ----------

export type Suffix = "jr" | "sr" | "ii" | "iii" | "iv";
export type NameParts = {
  first: string | null;
  surname: string;
  suffix: Suffix | null;
  /** A last word cut off at the card's edge that looks like the start of "Jr" or "Sr" ("Ken Griffey, J"). */
  suffixCut: "jr" | "sr" | null;
};

const SUFFIXES: readonly Suffix[] = ["jr", "sr", "ii", "iii", "iv"];
const MAX_NAME = 80;

/**
 * Bracketed qualifiers ("Dave Johnson (P)", "Jeff Robinson (Texas)") say which
 * of two players is meant; they are not part of the name. A bracket left open
 * at the edge of the card is dropped to the end.
 */
export function dropQualifiers(raw: string): string {
  return raw.replace(/[([{][^)\]}]*(?:[)\]}]|$)/g, " ");
}

/**
 * Words that belong to the surname when they stand before it ("De La Cruz",
 * "St. Claire", "La Russa", "O Neill"). Such a word is never a first name or
 * the start of one. normalizeName has already dropped the dot of "St.".
 */
const PARTICLES: ReadonlySet<string> = new Set(["de", "la", "del", "los", "las", "da", "di", "le", "van", "von", "st", "mc", "o"]);

/**
 * Lowercase, no accents, no punctuation, bracketed qualifiers dropped, "jr"
 * and "sr" set apart, particles joined into the surname ("Elly De La Cruz"
 * gives surname "delacruz"). Null when there is no usable surname.
 */
export function parseName(raw: string | null | undefined): NameParts | null {
  const tokens = normalizeName(dropQualifiers(String(raw ?? "").slice(0, MAX_NAME))).split(" ").filter(Boolean);
  let suffix: Suffix | null = null;
  let suffixCut: NameParts["suffixCut"] = null;
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && (SUFFIXES as readonly string[]).includes(last)) {
    suffix = last as Suffix;
    tokens.pop();
  } else if (tokens.length >= 3 && (last === "j" || last === "s")) {
    suffixCut = last === "j" ? "jr" : "sr";
    tokens.pop();
  }
  let surname = tokens.pop();
  while (surname && tokens.length > 0 && PARTICLES.has(tokens[tokens.length - 1])) surname = tokens.pop() + surname;
  if (!surname || surname.length < 2) return null;
  return { first: tokens.length >= 1 ? tokens[0] : null, surname, suffix, suffixCut };
}

/**
 * The reading mix-ups folded away (l, i and 1 to l; 0 to o; 5 to s; 8 to b;
 * rn to m), so "Wltt" and "Witt" are the same surname. Nothing else is forgiven.
 */
export function foldOcr(s: string): string {
  return s.replace(/rn/g, "m").replace(/[i1]/g, "l").replace(/0/g, "o").replace(/5/g, "s").replace(/8/g, "b");
}

/** Surname up to 3 letters must be exact; 4 to 7 letters at most 1; 8 or more at most 2. */
export function allowedDistance(surnameLength: number): number {
  if (surnameLength <= 3) return 0;
  if (surnameLength <= 7) return 1;
  return 2;
}

/** The usual reading mix-ups, each costing one half. */
const MIXUPS: ReadonlyArray<readonly string[]> = [["l", "i", "1"], ["o", "0"], ["s", "5"], ["b", "8"]];
const MIXUP_OF = new Map<string, number>();
MIXUPS.forEach((group, i) => group.forEach((ch) => MIXUP_OF.set(ch, i)));

function subCost(a: string, b: string): number {
  if (a === b) return 0;
  const ga = MIXUP_OF.get(a);
  return ga !== undefined && ga === MIXUP_OF.get(b) ? 0.5 : 1;
}

let ROWS: Float64Array[] = [0, 1, 2].map(() => new Float64Array(MAX_NAME + 1));

/**
 * Edit distance where a swap of two neighbours counts 1, the reading mix-ups
 * (l, I and 1; O and 0; S and 5; B and 8; rn and m) count one half and
 * everything else 1. Gives Infinity as soon as the answer must be above `max`
 * (lengths too far apart, or a whole row above it), so most pairs stop early.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  // Each letter of length difference costs at least one half (rn and m).
  if (Math.abs(la - lb) * 0.5 > max) return Infinity;
  // Three rows reused between calls (names are at most MAX_NAME letters): no allocation per pair.
  if (lb + 1 > ROWS[0].length) ROWS = [0, 1, 2].map(() => new Float64Array(lb + 1));
  let [prev2, prev, cur] = ROWS;
  prev2.fill(0, 0, lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cb = b[j - 1];
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(ca, cb));
      if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb && ca !== cb) v = Math.min(v, prev2[j - 2] + 1);
      // "rn" read for "m", or "m" read for "rn".
      if (i > 1 && cb === "m" && ca === "n" && a[i - 2] === "r") v = Math.min(v, prev2[j - 1] + 0.5);
      if (j > 1 && ca === "m" && cb === "n" && b[j - 2] === "r") v = Math.min(v, prev[j - 2] + 0.5);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return Infinity;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb] <= max ? prev[lb] : Infinity;
}

/**
 * How far a read first name is from the true one, or Infinity when it
 * contradicts. A prefix counts only for an initial or a read under 3 letters
 * ("K" or "Ke" fits Ken); anything longer must be exact or close spelling,
 * and a first name of up to 3 letters must be exact ("Ken" never fits "Kent",
 * "Kevin" never fits "Ken").
 */
export function firstDistance(read: string | null, truth: string | null): number {
  if (!read || !truth || read === truth) return 0;
  if (read.length < 3) return truth.startsWith(read) ? 0 : Infinity;
  // The catalog itself has only an initial ("J. Smith").
  if (truth.length === 1) return read.startsWith(truth) ? 0 : Infinity;
  const allowed = allowedDistance(Math.min(read.length, truth.length));
  return editDistance(read, truth, allowed);
}

/** A first name or initial that was read must not contradict: "K" or "Ken" fits Ken, not Kevin and not Kent. */
export function firstFits(read: string | null, truth: string | null): boolean {
  return firstDistance(read, truth) !== Infinity;
}

const CUT_COST = 0.5;

/** How much of a first name was read: a whole one, an initial (or under 3 letters), or none. */
export type FirstRead = "full" | "short" | "none";

export type NameCompare = {
  /** Whole name: surname, suffix and first name together. Infinity when it contradicts or is too far. */
  distance: number;
  /** The same without looking at the first name (who else carries this surname). */
  surname: number;
  firstRead: FirstRead;
};

/**
 * Compares a read name with a true name; nothing above `max` is reported.
 * When the first name contradicts, the surname is measured only up to its own
 * allowed distance (enough to know who else carries it), which keeps most
 * comparisons short.
 */
export function compareNames(read: NameParts, truth: NameParts, max: number): NameCompare {
  const firstRead: FirstRead = !read.first ? "none" : read.first.length < 3 ? "short" : "full";
  const none: NameCompare = { distance: Infinity, surname: Infinity, firstRead };
  const rs = read.suffix ?? read.suffixCut;
  const ts = truth.suffix;
  if (rs && ts && rs !== ts) return none;
  const first = firstDistance(read.first, truth.first);
  if (first === Infinity) max = Math.min(max, allowedDistance(truth.surname.length));
  let extra = 0;
  if (read.suffixCut) extra += CUT_COST;
  else if (read.suffix && !ts) extra += CUT_COST;
  if (extra > max) return none;
  let d = editDistance(read.surname, truth.surname, max - extra);
  // A surname cut off at the edge of the card ("Griff" for "Griffey").
  const r = read.surname;
  const t = truth.surname;
  if (!read.suffix && !read.suffixCut && r.length >= 4 && r.length * 2 >= t.length && r.length < t.length && t.startsWith(r)) {
    d = Math.min(d, CUT_COST);
  }
  const surname = d + extra;
  if (!(surname <= max)) return none;
  const total = surname + first;
  return { distance: total <= max ? total : Infinity, surname, firstRead };
}

/**
 * How far a read name is from a true name, or Infinity when it contradicts
 * (other first name, Jr. against Sr.) or is further than `max`. A cut off
 * last word costs one half.
 */
export function nameDistance(read: NameParts, truth: NameParts, max: number): number {
  return compareNames(read, truth, max).distance;
}

// ---------- slim rows ----------

/** One card turned once into what matching needs (cheap to compare many times). */
export type SlimRow = {
  card: CatalogCard;
  number: string | null;
  names: NameParts[];
  /**
   * The player as parsed first name, surname and suffix ("dave|johnson|"), to
   * tell two cards of one player from two players. Empty when the name has no
   * usable surname.
   */
  playerKey: string;
  /** A variation (Tiffany or any other), an insert set or an unverified listing: never applied by the app. */
  special: boolean;
  /** All-Star, Record Breaker, Checklist and the like: never applied, a candidate only. */
  subset: boolean;
};

const MAX_ROW_NAMES = 4;

/** Tags that mark another version of a card, not the plain one. */
const VARIATION_TAGS: readonly string[] = ["ERR", "COR", "ERROR", "SP", "NO NAME ON FRONT", "BLACKBOX", "BLACK BOX"];
/** Tags that mark a subset card inside the base set. */
const SUBSET_TAGS: readonly string[] = ["AS", "RB", "TL", "LL", "CL", "CHECKLIST", "DP", "FDP", "MEM", "MVP", "IR", "TC"];
const SUBSET_WORDS =
  /\b(all[- ]?stars?|record breakers?|salute|team leaders?|league leaders?|checklists?|highlights?|turn back the clock|future stars?|draft picks?|prospects?)\b/i;

/** A variation (Tiffany or any other), an insert set or an unverified listing. Never sure, even when that very product was read. */
export function isSpecial(card: CatalogCard): boolean {
  if (!card.verified) return true;
  if (card.setName) return true;
  if (card.variation) return true;
  return card.tags.some((t) => VARIATION_TAGS.includes(t));
}

/** A subset card of the base set (or a card of several players): a candidate only, never applied. */
export function isSubset(card: CatalogCard): boolean {
  return card.otherPlayers.length > 0 || card.tags.some((t) => SUBSET_TAGS.includes(t)) || SUBSET_WORDS.test(card.player ?? "");
}

/** The player as parsed first name, surname and suffix. */
export function playerKeyOf(name: NameParts | null): string {
  return name ? `${name.first ?? ""}|${name.surname}|${name.suffix ?? ""}` : "";
}

export function slimRow(card: CatalogCard): SlimRow {
  const names: NameParts[] = [];
  for (const n of [card.player, ...card.otherPlayers].slice(0, MAX_ROW_NAMES)) {
    const p = parseName(n);
    if (p) names.push(p);
  }
  return {
    card, number: card.cardNumber, names, playerKey: playerKeyOf(parseName(card.player)),
    special: isSpecial(card), subset: isSubset(card),
  };
}

export function slimRows(cards: readonly CatalogCard[]): SlimRow[] {
  return cards.map((c) => slimRow(c));
}

// ---------- judging ----------

export type MatchRead = { spellings: NameParts[]; number: string | null };

export function matchRead(names: readonly string[], cardNumber: string | null | undefined): MatchRead {
  const spellings: NameParts[] = [];
  for (const n of names.slice(0, 5)) {
    const p = parseName(n);
    if (p) spellings.push(p);
  }
  return { spellings, number: cleanCardNumber(cardNumber ?? null) };
}

export type Candidate = CatalogCard & { score: number; why: string };

/** Largest allowed distance (2) plus the one more edit of the clear margin rule. */
const MARGIN_CAP = 3;

type Scored = {
  row: SlimRow;
  /** Best distance over the read spellings, Infinity when no name fits within allowed plus one. */
  distance: number;
  fits: boolean;
  /** The surname alone fits (the first name aside): someone else who carries this surname. */
  surnameFits: boolean;
  /** How much of a first name the best fitting spelling had. */
  firstRead: FirstRead;
  numberAgrees: boolean;
  tier: number;
  order: number;
};

/** Number and name agree; name exact; name close; number only. */
function tierOf(fits: boolean, exact: boolean, numberAgrees: boolean): number {
  if (fits && numberAgrees) return 3;
  if (fits && exact) return 2;
  if (fits) return 1;
  return numberAgrees ? 0.5 : 0;
}

const FIRST_RANK: Record<FirstRead, number> = { full: 2, short: 1, none: 0 };

function scoreRow(row: SlimRow, read: MatchRead, order: number): Scored {
  let distance = Infinity;
  let fits = false;
  let surnameFits = false;
  let firstRead: FirstRead = "none";
  if (row.card.verified) {
    for (const truth of row.names) {
      const allowed = allowedDistance(truth.surname.length);
      for (const r of read.spellings) {
        // Up to the largest allowed plus one, so the clear margin rule can see the runner up.
        const c = compareNames(r, truth, MARGIN_CAP);
        if (c.surname <= allowed) surnameFits = true;
        if (c.distance < distance || (c.distance === distance && c.distance !== Infinity && FIRST_RANK[c.firstRead] > FIRST_RANK[firstRead])) {
          distance = c.distance;
          firstRead = c.firstRead;
        }
        if (c.distance <= allowed) fits = true;
      }
    }
  }
  const numberAgrees = Boolean(read.number && row.number && row.number === read.number);
  return { row, distance, fits, surnameFits, firstRead, numberAgrees, tier: tierOf(fits, fits && distance === 0, numberAgrees), order };
}

function why(s: Scored): string {
  const parts: string[] = [];
  if (!s.row.card.verified) parts.push("Unverified listing");
  else if (s.tier === 3) parts.push("Number and name agree");
  else if (s.tier === 2) parts.push("Name matches");
  else if (s.tier === 1) parts.push("Name is close");
  else if (s.tier === 0.5) parts.push("Number matches, name differs");
  if (s.row.card.verified && s.row.special) parts.push(s.row.card.variation ? `Special version: ${s.row.card.variation}` : "Not the plain base card");
  else if (s.row.card.verified && s.row.subset) parts.push("All-Star or other special card of the set");
  return parts.join(". ");
}

function toCandidate(s: Scored): Candidate {
  const score = s.row.card.verified
    ? Math.max(0, Math.round((s.tier * 10 - (Number.isFinite(s.distance) ? s.distance : 0) - (s.row.special ? 1 : 0) - (s.row.subset ? 0.5 : 0)) * 10) / 10)
    : 0;
  return { ...s.row.card, score, why: why(s) };
}

/**
 * The number path's name check: surname exact after folding, a read first
 * name or initial agrees, and a shared surname needs a first name read.
 */
function strictName(s: Scored, read: MatchRead, pool: readonly Scored[]): boolean {
  const truth = s.row.names[0];
  if (!truth) return false;
  const surname = foldOcr(truth.surname);
  const shared = pool.some((o) => o.row.playerKey !== s.row.playerKey && o.row.names.some((n) => foldOcr(n.surname) === surname));
  return read.spellings.some((r) => {
    if (foldOcr(r.surname) !== surname) return false;
    const rs = r.suffix ?? r.suffixCut;
    if (rs && truth.suffix && rs !== truth.suffix) return false;
    return r.first ? firstFits(r.first, truth.first) : !shared;
  });
}

export type Judgement = {
  sure: Candidate | null;
  /** "number": number and name agree. "name": the one player of a complete set, applied without a read number. */
  sureBy: "number" | "name" | null;
  candidates: Candidate[];
};

export const MAX_CANDIDATES = 5;

/**
 * Judges a pool of rows. `wholeSet`: the pool holds whole sets (every
 * checklist complete), so "no other player fits" can be checked. A search
 * answer or a checklist cut short (the source sends at most 500 cards) is
 * never a whole set.
 *
 * A card is sure ONLY when
 * (a) the read number and the name agree with exactly one clean card that is
 *     not a subset card and not a variation, or
 * (b) no number was read, the pool is a whole set, exactly one player in it
 *     fits the read name (first name, surname and suffix compared on parsed
 *     names), and that player has exactly one plain card there.
 * Everything else is a ranked candidate for Review.
 *
 * `baseSetIds`: the known base set ids of the read sport, year and brand. A
 * sure card must come from one of them; an empty list means nothing is sure
 * (sport, year or brand not read, or no base set known). Left out only by
 * tests of the name rules alone; lookup always passes it.
 *
 * On the number path the surname must be exact after folding the reading
 * mix-ups (no close spelling), a read first name or initial must agree, and
 * when another player of the pool carries that surname a first name or
 * initial must have been read.
 */
export function judge(rows: readonly SlimRow[], read: MatchRead, wholeSet: boolean, baseSetIds?: readonly string[]): Judgement {
  const scored: Scored[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    if (seen.has(row.card.sourceId)) return;
    seen.add(row.card.sourceId);
    scored.push(scoreRow(row, read, i));
  });
  const keep = scored.filter((s) => s.tier > 0 || !s.row.card.verified);
  keep.sort((x, y) => {
    if (x.row.card.verified !== y.row.card.verified) return x.row.card.verified ? -1 : 1;
    if (y.tier !== x.tier) return y.tier - x.tier;
    if (x.row.special !== y.row.special) return x.row.special ? 1 : -1;
    if (x.row.subset !== y.row.subset) return x.row.subset ? 1 : -1;
    if (x.distance !== y.distance) return x.distance - y.distance;
    return x.order - y.order;
  });
  const candidates = keep.slice(0, MAX_CANDIDATES).map(toCandidate);
  const verified = scored.filter((s) => s.row.card.verified);
  // Only a clean base card is ever applied: no variation, insert, listing or subset card.
  const inBase = (s: Scored) => !baseSetIds || (s.row.card.sourceSetId !== null && baseSetIds.includes(s.row.card.sourceSetId));
  const plain = verified.filter((s) => !s.row.special && !s.row.subset && inBase(s));
  let sure: Scored | null = null;
  let sureBy: Judgement["sureBy"] = null;

  if (read.number) {
    // A read number that disagrees with the best name match is never overwritten.
    const both = plain.filter((s) => s.fits && s.numberAgrees);
    if (both.length === 1 && strictName(both[0], read, verified)) {
      sure = both[0];
      sureBy = "number";
    }
  } else if (wholeSet) {
    const fitting = verified.filter((s) => s.fits).sort((x, y) => x.distance - y.distance || x.order - y.order);
    const best = fitting[0];
    if (best && best.row.playerKey) {
      const player = best.row.playerKey;
      // Another player who fits too (exact name), or comes within one more edit (close name).
      const rival = verified.some((s) => s.row.playerKey !== player && (best.distance === 0 ? s.fits : s.distance <= best.distance + 1));
      const base = plain.filter((s) => s.fits && s.row.playerKey === player);
      if (!rival && base.length === 1) {
        sure = base[0];
        sureBy = "name";
      }
    }
  }
  return { sure: sure ? toCandidate(sure) : null, sureBy, candidates };
}
