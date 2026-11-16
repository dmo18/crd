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

/** Lowercase, no accents, no punctuation, "jr" and "sr" set apart. Null when there is no usable surname. */
export function parseName(raw: string | null | undefined): NameParts | null {
  const tokens = normalizeName(String(raw ?? "").slice(0, MAX_NAME)).split(" ").filter(Boolean);
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
  const surname = tokens[tokens.length - 1];
  if (!surname || surname.length < 2) return null;
  return { first: tokens.length >= 2 ? tokens[0] : null, surname, suffix, suffixCut };
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
  let prev2 = new Float64Array(lb + 1);
  let prev = new Float64Array(lb + 1);
  let cur = new Float64Array(lb + 1);
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
  /** The player's name as a key, to tell two cards of one player from two players. */
  playerKey: string;
  /** A variation (Tiffany or any other), an insert set or an unverified listing: never applied by the app. */
  special: boolean;
  /** All-Star, Record Breaker, Checklist and the like: applied only when the read number agrees. */
  subset: boolean;
  /** The subset words are part of the name itself ("Nolan Ryan Salute-New York Mets"): not a player's name to search for. */
  subsetInName: boolean;
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

/** A subset card of the base set (or a card of several players): a candidate only, unless the read number agrees. */
export function isSubset(card: CatalogCard): boolean {
  return card.otherPlayers.length > 0 || card.tags.some((t) => SUBSET_TAGS.includes(t)) || SUBSET_WORDS.test(card.player ?? "");
}

export function slimRow(card: CatalogCard): SlimRow {
  const names: NameParts[] = [];
  for (const n of [card.player, ...card.otherPlayers].slice(0, MAX_ROW_NAMES)) {
    const p = parseName(n);
    if (p) names.push(p);
  }
  return {
    card, number: card.cardNumber, names, playerKey: normalizeName(card.player ?? ""),
    special: isSpecial(card), subset: isSubset(card), subsetInName: SUBSET_WORDS.test(card.player ?? ""),
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

export type Judgement = {
  sure: Candidate | null;
  /** "number": number and name agree. "name": applied without a read number. */
  sureBy: "number" | "name" | null;
  candidates: Candidate[];
  /**
   * Only for a set that was cut short: the card whose player's name was found
   * and must be confirmed by one exact search before anything is applied.
   */
  confirm: CatalogCard | null;
};

export const MAX_CANDIDATES = 5;

/**
 * What the pool of rows is:
 * - "search": a search answer, never a whole set. Only number and name together make a sure card.
 * - "complete": whole sets, so "no other card fits" can be checked.
 * - "partial": a checklist cut short (the source sends at most 500 cards).
 *   Nothing is sure by name here; a name that stands alone in the part we
 *   have is handed back as `confirm`.
 */
export type PoolKind = "search" | "complete" | "partial";

export function judge(rows: readonly SlimRow[], read: MatchRead, kind: PoolKind): Judgement {
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
  // A variation, an insert or a listing is never applied.
  const plain = scored.filter((s) => s.row.card.verified && !s.row.special);
  let sure: Scored | null = null;
  let sureBy: Judgement["sureBy"] = null;
  let confirm: CatalogCard | null = null;

  if (read.number) {
    // A read number that disagrees with the best name match is never overwritten.
    // With the number, a subset card (All-Star and the like) can be the sure card.
    const both = plain.filter((s) => s.fits && s.numberAgrees);
    if (both.length === 1) {
      sure = both[0];
      sureBy = "number";
    }
  } else if (kind !== "search") {
    const fitting = plain
      .filter((s) => s.fits)
      .sort((x, y) => x.distance - y.distance || Number(x.row.subset) - Number(y.row.subset) || x.order - y.order);
    const best = fitting[0];
    if (best) {
      const player = best.row.playerKey;
      // Another player who fits too (exact name), or comes within one more edit (close name).
      const rival = plain.some((s) => s.row.playerKey !== player && (best.distance === 0 ? s.fits : s.distance <= best.distance + 1));
      // The player's own plain cards: a subset card is never the one applied without its number.
      const base = fitting.filter((s) => s.row.playerKey === player && !s.row.subset);
      if (!rival && kind === "complete") {
        if (base.length === 1) {
          sure = base[0];
          sureBy = "name";
        }
      } else if (!rival && base.length <= 1) {
        // Cut short: the cards we cannot see may hold the same surname. An
        // initial (or no first name) does not pick one player when the part
        // we do see already has others of that surname.
        const sharedSurname = best.firstRead !== "full" && plain.some((s) => s.row.playerKey !== player && s.surnameFits);
        const named = base[0] ?? fitting.find((s) => s.row.playerKey === player && !s.row.subsetInName);
        if (!sharedSurname && named) confirm = named.row.card;
      }
    }
  }
  return { sure: sure ? toCandidate(sure) : null, sureBy, candidates, confirm };
}

/**
 * The answer of the one confirm search ("year brand full corrected name")
 * for a name found in a checklist that was cut short. Sure only when it shows
 * exactly one clean card of that player in that set that is not a subset, a
 * variation or an insert, and its number does not disagree with a read one.
 * `rows`: the clean rows of the answer, already of the right year, brand and sport.
 */
export function judgeConfirm(rows: readonly SlimRow[], target: CatalogCard, read: MatchRead): { sure: Candidate | null; candidates: Candidate[] } {
  const player = normalizeName(target.player ?? "");
  const seen = new Set<string>();
  const scored: Scored[] = [];
  rows.forEach((row, i) => {
    if (!row.card.verified || row.playerKey !== player || !player || seen.has(row.card.sourceId)) return;
    seen.add(row.card.sourceId);
    scored.push(scoreRow(row, read, i));
  });
  const inSet = scored.filter((s) => target.sourceSetId !== null && s.row.card.sourceSetId === target.sourceSetId);
  const base = inSet.filter((s) => !s.row.special && !s.row.subset && s.fits);
  const one = base.length === 1 && !(read.number && base[0].row.number !== read.number) ? base[0] : null;
  const candidates = [...inSet, ...scored.filter((s) => !inSet.includes(s))]
    .filter((s) => s.tier > 0)
    .sort((x, y) => Number(inSet.includes(y)) - Number(inSet.includes(x)) || Number(x.row.special) - Number(y.row.special) || Number(x.row.subset) - Number(y.row.subset) || x.order - y.order)
    .slice(0, MAX_CANDIDATES)
    .map(toCandidate);
  return { sure: one ? toCandidate(one) : null, candidates };
}
