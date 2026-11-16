import type { CatalogCard } from "./types";
import { cleanCardNumber } from "./clean";
import { normalizeBrand, normalizeName } from "./normalize";

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

/** A first name or initial that was read must not contradict: "K" or "Ken" fits Ken, not Kevin. */
export function firstFits(read: string | null, truth: string | null): boolean {
  if (!read || !truth) return true;
  if (truth.startsWith(read) || (truth.length >= 3 && read.startsWith(truth))) return true;
  return editDistance(read, truth, allowedDistance(truth.length)) <= allowedDistance(truth.length);
}

const CUT_COST = 0.5;

/**
 * How far a read name is from a true name, or Infinity when it contradicts
 * (other first name, Jr. against Sr.) or is further than `max`. Measured on
 * the surname; a cut off last word costs one half.
 */
export function nameDistance(read: NameParts, truth: NameParts, max: number): number {
  const rs = read.suffix ?? read.suffixCut;
  const ts = truth.suffix;
  if (rs && ts && rs !== ts) return Infinity;
  let extra = 0;
  if (read.suffixCut) extra += CUT_COST;
  else if (read.suffix && !ts) extra += CUT_COST;
  if (extra > max) return Infinity;
  if (!firstFits(read.first, truth.first)) return Infinity;
  let d = editDistance(read.surname, truth.surname, max - extra);
  // A surname cut off at the edge of the card ("Griff" for "Griffey").
  const r = read.surname;
  const t = truth.surname;
  if (!read.suffix && !read.suffixCut && r.length >= 4 && r.length * 2 >= t.length && r.length < t.length && t.startsWith(r)) {
    d = Math.min(d, CUT_COST);
  }
  const total = d + extra;
  return total <= max ? total : Infinity;
}

// ---------- slim rows ----------

/** One card turned once into what matching needs (cheap to compare many times). */
export type SlimRow = {
  card: CatalogCard;
  number: string | null;
  names: NameParts[];
  /** Tiffany and other special products, or an insert set: candidates only. */
  special: boolean;
};

const MAX_ROW_NAMES = 4;

/** Special unless it is the plain base card, or the reader read that very product (never Tiffany). */
export function isSpecial(card: CatalogCard, readBrandKeys: readonly string[] = []): boolean {
  if (!card.verified) return true;
  if (card.setName) return true;
  if (!card.variation) return false;
  if (/tiffany/i.test(card.variation)) return true;
  const product = normalizeBrand(`${card.brand ?? ""} ${card.variation}`);
  return !readBrandKeys.includes(product);
}

export function slimRow(card: CatalogCard, readBrandKeys: readonly string[] = []): SlimRow {
  const names: NameParts[] = [];
  for (const n of [card.player, ...card.otherPlayers].slice(0, MAX_ROW_NAMES)) {
    const p = parseName(n);
    if (p) names.push(p);
  }
  return { card, number: card.cardNumber, names, special: isSpecial(card, readBrandKeys) };
}

export function slimRows(cards: readonly CatalogCard[], readBrandKeys: readonly string[] = []): SlimRow[] {
  return cards.map((c) => slimRow(c, readBrandKeys));
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

function scoreRow(row: SlimRow, read: MatchRead, order: number): Scored {
  let distance = Infinity;
  let fits = false;
  if (row.card.verified) {
    for (const truth of row.names) {
      const allowed = allowedDistance(truth.surname.length);
      for (const r of read.spellings) {
        // Up to the largest allowed plus one, so the clear margin rule can see the runner up.
        const d = nameDistance(r, truth, MARGIN_CAP);
        if (d < distance) distance = d;
        if (d <= allowed) fits = true;
      }
    }
  }
  const numberAgrees = Boolean(read.number && row.number && row.number === read.number);
  return { row, distance, fits, numberAgrees, tier: tierOf(fits, fits && distance === 0, numberAgrees), order };
}

function why(s: Scored): string {
  const parts: string[] = [];
  if (!s.row.card.verified) parts.push("Unverified listing");
  else if (s.tier === 3) parts.push("Number and name agree");
  else if (s.tier === 2) parts.push("Name matches");
  else if (s.tier === 1) parts.push("Name is close");
  else if (s.tier === 0.5) parts.push("Number matches, name differs");
  if (s.row.card.verified && s.row.special) parts.push(s.row.card.variation ? `Special version: ${s.row.card.variation}` : "Not the base set");
  return parts.join(". ");
}

function toCandidate(s: Scored): Candidate {
  const score = s.row.card.verified ? Math.max(0, Math.round((s.tier * 10 - (Number.isFinite(s.distance) ? s.distance : 0) - (s.row.special ? 1 : 0)) * 10) / 10) : 0;
  return { ...s.row.card, score, why: why(s) };
}

export type Judgement = {
  sure: Candidate | null;
  /** "number": number and name agree. "name": applied without a read number. */
  sureBy: "number" | "name" | null;
  candidates: Candidate[];
};

export const MAX_CANDIDATES = 5;

/**
 * Judges a pool of rows. `wholeSets` says the pool holds whole fetched sets,
 * so "no other card in the sets" can be checked; a search answer is not a
 * whole set, so there only number and name together make a sure card.
 */
export function judge(rows: readonly SlimRow[], read: MatchRead, wholeSets: boolean): Judgement {
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
    if (x.distance !== y.distance) return x.distance - y.distance;
    return x.order - y.order;
  });
  const candidates = keep.slice(0, MAX_CANDIDATES).map(toCandidate);
  const plain = scored.filter((s) => s.row.card.verified && !s.row.special);
  let sure: Scored | null = null;
  let sureBy: Judgement["sureBy"] = null;

  if (read.number) {
    // A read number that disagrees with the best name match is never overwritten.
    const both = plain.filter((s) => s.fits && s.numberAgrees);
    if (both.length === 1) {
      sure = both[0];
      sureBy = "number";
    }
  } else if (wholeSets) {
    const fitting = plain.filter((s) => s.fits).sort((x, y) => x.distance - y.distance);
    const best = fitting[0];
    if (best) {
      const others = plain.filter((s) => s !== best);
      const clear =
        best.distance === 0
          ? !others.some((s) => s.fits)
          : !others.some((s) => s.distance <= best.distance + 1);
      if (clear) {
        sure = best;
        sureBy = "name";
      }
    }
  }
  return { sure: sure ? toCandidate(sure) : null, sureBy, candidates };
}
