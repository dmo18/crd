import type { ProductType, Sport } from "@/db/schema";
import { KEY_CARDS, normalizeName } from "./key-cards";
import type { OcrLine, OcrResult } from "./ocr";

/**
 * Turns noisy text read from a card, slab label or product box into card details.
 * No AI and no network: only patterns, word lists and the built-in key card list.
 * OCR mistakes are expected (O for 0, l or I for 1, S for 5, broken words), so
 * matching is forgiving where it is safe and strict where a wrong guess would hurt.
 * Nothing here throws: on any problem the fields stay empty.
 */

export type ParsedCard = {
  year: number | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  /** Most likely first, at most 5, "First Last" in title case. */
  playerCandidates: string[];
  /**
   * The first word of a bio sentence that starts with a name ("Ken graduated
   * from ..."): a first name hint, never a player name on its own.
   */
  firstNameHint: string | null;
  /** Only when read for sure: one team, exactly, in capitals, on a team line. */
  team: string | null;
  /**
   * A team reading that is not sure enough to write (a close spelling, a
   * team in a sentence, or two teams read). Shown to the owner as a
   * suggestion; the recognizer writes it only when Wikidata confirms it.
   */
  teamHint: string | null;
  teamHintSport: Sport | null;
  sport: Sport | null;
  position: string | null;
  /** From a graded holder (slab) label. */
  grader: string | null;
  grade: string | null;
  certNumber: string | null;
  /** "045/100" style. */
  serialNumber: string | null;
  /** The same read with its line and whether it is weak (only a suggestion). */
  serialRead: SerialRead | null;
  /** The word ROOKIE or RC was read on the card. */
  rookieWord: boolean;
  /** Autograph wording read (AUTO, SIGNATURES, PSA/DNA, CERTIFIED AUTOGRAPH). */
  isAutograph: boolean;
  /** The card says REPRINT: it is not the original card. */
  isReprint: boolean;
  /** Short plain notes of what was read, for the item's notes. */
  evidence: string[];
};

export type ParsedProduct = {
  year: number | null;
  yearEnd: number | null;
  brand: string | null;
  setName: string | null;
  sport: Sport | null;
  productType: ProductType | null;
  packCount: number | null;
  estCount: number | null;
  containerType: string | null;
  evidence: string[];
};

// ---------------------------------------------------------------------------
// Lines

type Side = "front" | "back";
type LineBox = { x: number; y: number; w: number; h: number };
type Line = {
  /** Cleaned text, copyright marks turned into a lone "\u00a9". */
  raw: string;
  /** Same length as raw, upper case. */
  up: string;
  /** Same length as raw, upper case with digits that look like letters turned into letters. */
  lz: string;
  tokens: string[];
  conf: number;
  box: LineBox;
  side: Side;
  /** "band": read from a wide colored strip on its own, so it may be a headline. */
  source: "page" | "band" | "edge";
};

const MAX_LINES = 400;
const MAX_LINE_CHARS = 300;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function cleanRaw(s: string): string {
  let plain = "";
  for (const c of s.slice(0, MAX_LINE_CHARS)) {
    const code = c.charCodeAt(0);
    plain += code < 32 || code === 127 ? " " : c;
  }
  return plain
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\(\s*[cCeE]\s*\)|[\u00a9\u00ae]/g, " \u00a9 ")
    .replace(/@(?=\s*[0-9OoIlSsg|]{4})/g, " \u00a9 ")
    .replace(/\s+/g, " ")
    // A small l inside a word in capitals is a capital I misread ("MARlNERS", "GRlFFEY").
    .replace(/\b[A-Zl]{3,}\b/g, (w) => (w.includes("l") && (w.match(/[A-Z]/g)?.length ?? 0) >= 2 ? w.replace(/l/g, "I") : w))
    .trim();
}

function upper(s: string): string {
  let out = "";
  for (const c of s) {
    const u = c.toUpperCase();
    out += u.length === c.length ? u : c;
  }
  return out;
}

const LZ_MAP: Record<string, string> = { "0": "O", "1": "I", "5": "S", "|": "I", $: "S" };

function letterize(up: string): string {
  let out = "";
  for (const c of up) out += LZ_MAP[c] ?? c;
  return out;
}

function makeLine(text: string, conf: number, box: LineBox, side: Side, source: Line["source"] = "page"): Line | null {
  const raw = cleanRaw(text);
  if (!raw) return null;
  const up = upper(raw);
  return { raw, up, lz: letterize(up), tokens: raw.split(" "), conf, box, side, source };
}

function lineSource(v: unknown): Line["source"] {
  return v === "band" || v === "edge" ? v : "page";
}

function toLines(ocr: OcrResult | null | undefined, side: Side): Line[] {
  if (!ocr || typeof ocr !== "object") return [];
  const out: Line[] = [];
  const lines: unknown = (ocr as { lines?: unknown }).lines;
  if (Array.isArray(lines) && lines.length > 0) {
    for (const l of lines.slice(0, MAX_LINES) as Partial<OcrLine>[]) {
      if (!l || typeof l.text !== "string") continue;
      const b = (l.box ?? {}) as Partial<LineBox>;
      const box = { x: num(b.x, 0), y: num(b.y, 0.5), w: num(b.w, 1), h: num(b.h, 0.03) };
      const line = makeLine(l.text, num(l.confidence, 0.5), box, side, lineSource(l.source));
      if (line) out.push(line);
    }
    return out;
  }
  const text = typeof ocr.text === "string" ? ocr.text : "";
  const parts = text.split(/\r?\n/).slice(0, MAX_LINES);
  const n = Math.max(parts.length, 1);
  parts.forEach((t, i) => {
    const line = makeLine(t, num(ocr.confidence, 0.5), { x: 0, y: i / n, w: 1, h: 1 / n }, side);
    if (line) out.push(line);
  });
  return out;
}

function isCopyrightLine(l: Line): boolean {
  return /\u00a9|COPYRIGHT|\bINC\b|\bCORP\b|\bLTD\b|\bCOMPANY\b|\bCO\b/.test(l.lz);
}

// ---------------------------------------------------------------------------
// Years

const YEAR_FIX: Record<string, string> = {
  O: "0", o: "0", Q: "0", D: "0", I: "1", l: "1", "|": "1", "!": "1", i: "1",
  S: "5", s: "5", Z: "2", z: "2", B: "8", g: "9", q: "9",
};

function stripEnds(t: string): string {
  return t.replace(/^[^0-9A-Za-z|!]+/, "").replace(/[^0-9A-Za-z|!]+$/, "");
}

function validYear(n: number): number | null {
  return Number.isInteger(n) && n >= 1950 && n <= 2030 ? n : null;
}

/** A plain four digit year, no fixes. */
function plainYear(t: string): number | null {
  const s = stripEnds(t);
  return /^\d{4}$/.test(s) ? validYear(Number(s)) : null;
}

/** A year shaped token with common OCR swaps fixed ("1g89" gives 1989). */
function fixedYear(t: string): number | null {
  const s = stripEnds(t);
  if (s.length !== 4 || (s.match(/\d/g) ?? []).length < 2) return null;
  let out = "";
  for (const c of s) {
    if (c >= "0" && c <= "9") out += c;
    else if (YEAR_FIX[c]) out += YEAR_FIX[c];
    else return null;
  }
  return validYear(Number(out));
}

/** "'87" gives 1987. Only with the apostrophe, and only 1950 to 1999. */
function shortYear(t: string): number | null {
  const m = /^'([5-9]\d)[.,;:]?$/.exec(t);
  return m ? 1900 + Number(m[1]) : null;
}

type YearFind = { year: number; how: "copyright" | "brand" | "stats"; score: number; line?: Line; lastSeason?: number };

/** The season a stat table row starts with ("87", "1987", "'87", "84-85"), or null. */
function rowSeason(first: string): number | null {
  const t = first.replace(/^'/, "");
  let m = /^(?:19)?([5-9]\d)$/.exec(t);
  if (m) return 1900 + Number(m[1]);
  m = /^(?:19)?([5-9]\d)-(?:19)?(\d{2})$/.exec(t);
  if (m && (Number(m[1]) + 1) % 100 === Number(m[2])) return 1900 + Number(m[1]);
  return null;
}

/**
 * Year from a stat table: the last season shown plus one. A row is a season
 * in the first column followed by at least 3 numbers, or by the club's name
 * in capitals (the reader often splits a row into the club and the numbers).
 * Header lines are not rows, see isStatRow.
 * Rows are taken top to bottom. The last two rows must be in order, one
 * season apart or the same season (a player on two clubs in one year).
 */
function yearFromStats(lines: Line[]): YearFind | null {
  for (const side of ["back", "front"] as const) {
    const found = yearFromTable(lines.filter((l) => l.side === side));
    if (found) return found;
  }
  return null;
}

/** True when a brand name is read in the line ("1989 UPPER DECK", "90 TOPPS"). */
function hasBrandWord(lz: string): boolean {
  return BRANDS.some((def) => {
    def.re.lastIndex = 0;
    return def.re.test(lz);
  });
}

/**
 * A row: season, then up to 3 club words in capitals and only numbers after
 * them, or 3 or more numbers. A header is not a row: a brand name after the
 * season ("1989 UPPER DECK") never counts, and a row with the club but no
 * numbers (the left half of a row the reader split) must pass clubOnly.
 */
function isStatRow(l: Line): boolean {
  const t = l.tokens;
  if (hasBrandWord(l.lz)) return false;
  const isNumber = (x: string) => /^[\d.]+%?$/.test(x);
  const rest = t.slice(1);
  if (rest.filter(isNumber).length >= 3) return true;
  let k = 0;
  let letters = 0;
  while (k < rest.length && k < 3 && /^[A-Z][A-Z.'-]*$/.test(rest[k])) {
    letters += rest[k].replace(/[^A-Z]/g, "").length;
    k++;
  }
  if (k === 0 || letters < 3 || rest[0].replace(/[^A-Z]/g, "") in POS_TOKENS) return false;
  const after = rest.slice(k);
  if (after.length === 0) return clubOnly(rest);
  return after.every(isNumber);
}

/** Words of card headers and checklists that are never a club: "88 ROOKIE", "87 DRAFT PICK", "1989 MONTHLY". */
const NOT_CLUB = new Set(["MONTHLY", "SCOREBOARD", "SPRING", "TRAINING", "PLAYOFF", "PLAYOFFS", "POSTSEASON", "STATS", "STATISTICS"]);
/** First words of two word club names ("SN BERNARDINO", "EL PASO", "NEW BRITAIN"). */
const PLACE_PREFIX = new Set([
  "SN", "SAN", "SANTA", "ST", "STE", "FT", "FORT", "PORT", "EL", "LA", "LAS", "LOS", "NEW", "SALT", "WEST", "EAST",
  "NORTH", "SOUTH", "GRAND", "CEDAR", "LITTLE", "GLENS", "PALM", "BATON", "CORPUS", "KANE", "QUAD", "TRI", "RANCHO",
  "WINSTON", "COLORADO", "OKLAHOMA", "KANSAS", "IOWA", "BOWIE", "WEST", "RED", "WHITE", "BLUE", "SPRINGFIELD",
]);

/**
 * A row with the club and no numbers (the reader split the row; the
 * numbers are on their own lines): one club word, or two when the first is a
 * place word ("SN BERNARDINO") or they are a city or team ("NEW YORK", "RED
 * SOX"). No card header words ("88 ROOKIE", "87 DRAFT PICK", "1989
 * MONTHLY") and no checklist names ("56 JOHN SMITH"). Two or four digit
 * seasons both count ("89 MARINERS", "1989 MARINERS").
 */
function clubOnly(words: string[]): boolean {
  if (words.length > 2) return false;
  const keys = words.map((w) => w.replace(/[^A-Z]/g, ""));
  const nick = (k: string) => NICK_GROUPS.some((g) => g.key.replace(/[^A-Z0-9]/g, "") === k);
  for (const k of keys) {
    if (NOT_CLUB.has(k) || (STOP_WORDS.has(k) && !nick(k)) || k === "STARS") return false;
  }
  if (keys.length === 1) return true;
  const both = keys.join(" ");
  return PLACE_PREFIX.has(keys[0]) || CITY_KEYS.has(normalizeName(both)) || NICK_GROUPS.some((g) => g.key === both);
}

function yearFromTable(lines: Line[]): YearFind | null {
  const rows: { season: number; y: number; i: number }[] = [];
  lines.forEach((l, i) => {
    if (l.tokens.length < 2) return;
    const season = rowSeason(l.tokens[0]);
    if (season != null && isStatRow(l)) rows.push({ season, y: l.box.y, i });
  });
  rows.sort((a, b) => a.y - b.y || a.i - b.i);
  if (rows.length < 2 || new Set(rows.map((r) => r.season)).size < 2) return null;
  const last = rows[rows.length - 1].season;
  const step = last - rows[rows.length - 2].season;
  if (step !== 0 && step !== 1) return null;
  if (last < 1950 || last > 1995) return null;
  return { year: last + 1, how: "stats", score: 2, lastSeason: last };
}

function findYear(lines: Line[], brandLines: Set<Line>): YearFind | null {
  let best: YearFind | null = null;
  const consider = (f: YearFind) => {
    if (!best || f.score > best.score) best = f;
  };
  for (const l of lines) {
    const copyright = l.raw.includes("\u00a9") || /COPYRIGHT/.test(l.lz);
    const branded = brandLines.has(l);
    if (!copyright && !branded) continue;
    const sideBonus = l.side === "back" ? 1 : 0;
    let found = false;
    for (const t of l.tokens) {
      const y = fixedYear(t);
      if (y == null) continue;
      if (copyright) consider({ year: y, how: "copyright", score: 5 + sideBonus, line: l });
      else consider({ year: y, how: "brand", score: 3 + sideBonus, line: l });
      found = true;
      break;
    }
    // Fronts often show a short year by the logo: "Donruss '87", "'89 Fleer".
    if (!found && branded) {
      for (const t of l.tokens) {
        const y = shortYear(t);
        if (y == null) continue;
        consider({ year: y, how: "brand", score: 2.5 + sideBonus, line: l });
        break;
      }
    }
  }
  const stats = yearFromStats(lines);
  if (stats) consider(stats);
  return best;
}

// ---------------------------------------------------------------------------
// Brands

type BrandDef = {
  key: string;
  brand: string;
  set?: string;
  re: RegExp;
  copyrightOnly?: boolean;
  /** A clue that loses to any other brand read on the card. */
  weak?: boolean;
  sport?: Sport;
  sportWeight?: number;
};

const BRANDS: BrandDef[] = [
  { key: "udminor", brand: "Upper Deck", set: "Upper Deck Minor League", re: /\bUPPER\s*DECK\s*MINOR\s*LEAGUE\b/g, sport: "baseball", sportWeight: 2 },
  { key: "sp", brand: "Upper Deck", set: "SP", re: /\bUPPER\s*DECK\s*SP\b|^SP$/g },
  { key: "stadiumclub", brand: "Topps", set: "Stadium Club", re: /\bSTADIUM\s*CLUB\b/g },
  { key: "ultra", brand: "Fleer", set: "Fleer Ultra", re: /\bULTRA\b/g },
  { key: "topps", brand: "Topps", re: /\bTOPPS\b/g },
  { key: "upperdeck", brand: "Upper Deck", re: /\bUPPER\s*DECK\b/g },
  // "F1EER" is a common misread; the 1 becomes I in the letter version of the line.
  { key: "fleer", brand: "Fleer", re: /\bF[LI]EER\b/g },
  { key: "donruss", brand: "Donruss", re: /\bDONRUS{1,2}\b/g, sport: "baseball", sportWeight: 1 },
  { key: "score", brand: "Score", re: /\bSCORE\b/g },
  // Score cards were made by Major League Marketing, named in the copyright line.
  { key: "mlm", brand: "Score", re: /\bMAJOR\s*LEAGUE\s*MARKETING\b/g },
  { key: "bowman", brand: "Bowman", re: /\bBOWMAN\b/g },
  { key: "opc", brand: "O-Pee-Chee", re: /\bO\s*-?\s*PEE\s*-?\s*CHEE\b|\bOPC\b/g },
  { key: "leafinc", brand: "Leaf", re: /\bLEAF\s*,?\s*INC\b/g },
  { key: "leaf", brand: "Leaf", re: /\bLEAF\b(?!\s*,?\s*INC)/g },
  { key: "proset", brand: "Pro Set", re: /\bPRO\s*SET\b/g, sport: "football", sportWeight: 1 },
  { key: "hoops", brand: "NBA Hoops", re: /\bHOOPS\b/g, sport: "basketball", sportWeight: 2 },
  // NBA Hoops backs carry only "NBA Properties" in the copyright line. Other
  // brands may print it too, so it counts only when no other brand was read.
  { key: "nbaprops", brand: "NBA Hoops", re: /\bNBA\s*PROPERTIES\b/g, copyrightOnly: true, weak: true, sport: "basketball", sportWeight: 2 },
  { key: "skybox", brand: "SkyBox", re: /\bSKY\s*BOX\b/g, sport: "basketball", sportWeight: 1 },
  { key: "pinnacle", brand: "Pinnacle", re: /\bPINNACLE\b/g },
  { key: "classic", brand: "Classic", re: /\bCLASSIC\b/g, copyrightOnly: true },
  { key: "star", brand: "Star", re: /\bSTAR\s*CO\b|\bSTAR\s*COMPANY\b/g, sport: "basketball", sportWeight: 1 },
  { key: "starc", brand: "Star", re: /\bSTAR\b/g, copyrightOnly: true, sport: "basketball", sportWeight: 1 },
  { key: "pacific", brand: "Pacific", re: /\bPACIFIC\s*TRADING\b/g },
  { key: "pacificc", brand: "Pacific", re: /\bPACIFIC\b/g, copyrightOnly: true },
  { key: "actionpacked", brand: "Action Packed", re: /\bACTION\s*PACKED\b/g, sport: "football", sportWeight: 1 },
  { key: "procards", brand: "Pro Cards", re: /\bPRO\s*CARDS\b/g, sport: "baseball", sportWeight: 2 },
  { key: "kelloggs", brand: "Kellogg's", re: /\bKELLOGG'?S?\b/g, sport: "baseball", sportWeight: 1 },
  { key: "drakes", brand: "Drake's", re: /\bDRAKE'?S\b/g, sport: "baseball", sportWeight: 1 },
  { key: "parkhurst", brand: "Parkhurst", re: /\bPARKHURST\b/g, sport: "hockey", sportWeight: 2 },
];

type BrandHit = { def: BrandDef; line: Line; score: number };

function brandHits(lines: Line[]): BrandHit[] {
  const hits: BrandHit[] = [];
  for (const l of lines) {
    const copyright = isCopyrightLine(l);
    const short = l.tokens.length <= 3;
    const hasYear = l.tokens.some((t) => fixedYear(t) != null);
    for (const def of BRANDS) {
      if (def.copyrightOnly && !copyright) continue;
      def.re.lastIndex = 0;
      const count = l.lz.match(def.re)?.length ?? 0;
      for (let i = 0; i < count; i++) {
        const score = def.weak ? 0.5 : 1 + (copyright ? 3 : 0) + (short ? 2 : 0) + (hasYear ? 1 : 0) + (l.side === "back" ? 0.5 : 0);
        hits.push({ def, line: l, score });
      }
    }
  }
  return hits;
}

type BrandPick = { brand: string; subSet: string | null; sport: Sport | null; sportWeight: number; lines: Line[] };

function pickBrand(hits: BrandHit[], year: number | null): BrandPick | null {
  if (hits.length === 0) return null;
  const scores = new Map<string, number>();
  const has = (k: string) => hits.some((h) => h.def.key === k);
  const leafIncOnly = has("leafinc") && !has("leaf");
  for (const h of hits) {
    let brand = h.def.brand;
    if (h.def.key === "leafinc") {
      // Donruss cards carry "Leaf, Inc." in the copyright line, since Leaf, Inc.
      // owned Donruss. From 1990 the same company also made the Leaf brand, so
      // "Leaf, Inc." alone no longer says which of the two it is.
      if (has("donruss") || (leafIncOnly && year != null && year < 1990)) brand = "Donruss";
      else if (leafIncOnly) continue;
    }
    scores.set(brand, (scores.get(brand) ?? 0) + h.score);
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const [b, s] of scores) {
    if (s > bestScore) {
      best = b;
      bestScore = s;
    }
  }
  if (!best) return null;
  const mine = hits.filter((h) => (h.def.brand === best && h.def.key !== "leafinc") || (h.def.key === "leafinc" && (best === "Donruss" || best === "Leaf")));
  const sub = mine.find((h) => h.def.set);
  const sportDef = mine.find((h) => h.def.sport);
  return {
    brand: best,
    subSet: sub?.def.set ?? null,
    sport: sportDef?.def.sport ?? null,
    sportWeight: sportDef?.def.sportWeight ?? 0,
    lines: mine.map((h) => h.line),
  };
}

const SUBSET_WORDS: [RegExp, string][] = [
  [/\bROOKIE\s*(?:&|AND|\/)?\s*TRADED\b/, "Traded"],
  [/\bTRADED\b/, "Traded"],
  [/\bUPDATE\b/, "Update"],
  [/\bSUPPLEMENTAL\b/, "Supplemental"],
  [/\bTHE\s*ROOKIES\b|\bROOKIES\b/, "Rookies"],
  [/\bTIFFANY\b/, "Tiffany"],
  [/\bGLOSSY\b/, "Glossy"],
  [/\bUSFL\b/, "USFL"],
  [/\bSTICKERS?\b/, "Stickers"],
];

function findSetName(pick: BrandPick | null, lines: Line[], cardNumber: string | null): string | null {
  if (!pick) return null;
  if (pick.subSet) return pick.subSet;
  const brandLines = new Set(pick.lines);
  for (const [re, word] of SUBSET_WORDS) {
    if (lines.some((l) => (brandLines.has(l) || l.tokens.length <= 2) && re.test(l.lz))) return `${pick.brand} ${word}`;
  }
  if (cardNumber) {
    if ((pick.brand === "Topps" || pick.brand === "Score") && /T/.test(cardNumber)) return `${pick.brand} Traded`;
    if (pick.brand === "Fleer" && /^U/.test(cardNumber)) return "Fleer Update";
  }
  return pick.brand;
}

// ---------------------------------------------------------------------------
// Card number

const DIGIT_FIX: Record<string, string> = { O: "0", o: "0", I: "1", l: "1", "|": "1", i: "1", S: "5", s: "5", B: "8" };

function fixDigits(s: string): string | null {
  let out = "";
  for (const c of s) {
    if (c >= "0" && c <= "9") out += c;
    else if (DIGIT_FIX[c]) out += DIGIT_FIX[c];
    else return null;
  }
  const n = out.replace(/^0+(?=\d)/, "");
  return n === "0" ? null : n;
}

/** "414", "4l4", "98T", "T42", "U-12" into a clean card number, or null. */
function numberToken(t: string | undefined, allowPrefix: boolean): string | null {
  if (!t) return null;
  const s = t.replace(/^[^0-9A-Za-z|]+/, "").replace(/[^0-9A-Za-z|]+$/, "");
  if (!/\d/.test(s) || s.length > 6) return null;
  let m = /^([0-9OoIl|SsB]{1,3})$/.exec(s);
  if (m) return fixDigits(m[1]);
  m = /^([0-9OoIl|SsB]{1,3})([Tt])$/.exec(s);
  if (m) {
    const d = fixDigits(m[1]);
    return d ? `${d}T` : null;
  }
  if (!allowPrefix) return null;
  m = /^([A-Za-z]{1,2})(-?)([0-9OoIl|SsB]{1,3})$/.exec(s);
  if (m && /^[A-Z]{1,2}$/.test(m[1])) {
    const d = fixDigits(m[3]);
    return d ? `${m[1]}${m[2]}${d}` : null;
  }
  return null;
}

/** Words that make "#1" or "No. 1" a draft pick or a ranking, not the card number. */
const NOT_A_CARD_NUMBER = /^(?:PICKS?|PICKED|DRAFT(?:S|ED)?|CHOICES?|ROUNDS?|STARTERS?|SELECT(?:ION|IONS|ED)?|OVERALL)$/;

function rankingNear(t: string[], i: number, len: number): boolean {
  for (let k = Math.max(0, i - 4); k <= Math.min(t.length - 1, i + len + 2); k++) {
    if (k >= i && k < i + len) continue;
    if (NOT_A_CARD_NUMBER.test(letterize(upper(t[k])).replace(/[^A-Z]/g, ""))) return true;
  }
  return false;
}

/** "98 T" read as two words is still a Traded number. */
function withTradedSuffix(n: string | null, next: string | undefined): string | null {
  if (n && /^\d+$/.test(n) && next && /^[Tt][.,]?$/.test(next)) return `${n}T`;
  return n;
}

function numberFromMarkers(l: Line): string | null {
  const t = l.tokens;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (/^(?:N[O0o]|n[o0])[.:]?$/.test(tok) && (t.length <= 6 || i <= 1)) {
      const n = withTradedSuffix(numberToken(t[i + 1], true), t[i + 2]);
      if (n && !rankingNear(t, i, 2)) return n;
    }
    let m = /^(?:N[O0o]|n[o0])[.:]([0-9A-Za-z|-]+)$/.exec(tok);
    if (m && (t.length <= 6 || i <= 1)) {
      const n = withTradedSuffix(numberToken(m[1], true), t[i + 1]);
      if (n && !rankingNear(t, i, 1)) return n;
    }
    m = /^#(.*)$/.exec(tok);
    if (m) {
      const n = m[1] ? withTradedSuffix(numberToken(m[1], true), t[i + 1]) : withTradedSuffix(numberToken(t[i + 1], true), t[i + 2]);
      if (n && !rankingNear(t, i, m[1] ? 1 : 2)) return n;
    }
  }
  return null;
}

function numberFromCorner(l: Line): string | null {
  const t = l.tokens;
  const traded = t.length === 2 && /^[Tt]$/.test(t[1]);
  if (t.length !== 1 && !traded) return null;
  const top = l.box.y < 0.2;
  const corner = l.box.x < 0.3 || l.box.x + l.box.w > 0.7;
  if (!top || !corner) return null;
  // A position such as "1B" in the corner is not a number.
  if (upper(t[0]) in POS_TOKENS) return null;
  return withTradedSuffix(numberToken(t[0], false), t[1]);
}

function findCardNumber(back: Line[], front: Line[]): string | null {
  // The number printed alone in a top corner is the most reliable clue, then a
  // "No." or "#" marker. Bio lines ("the No. 1 pick") are skipped by the marker check.
  for (const l of back) {
    const n = numberFromCorner(l);
    if (n) return n;
  }
  for (const l of back) {
    const n = numberFromMarkers(l);
    if (n) return n;
  }
  for (const l of front) {
    const n = numberFromMarkers(l);
    if (n) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Teams

type TeamDef = { sport: Sport; city: string; nick: string; alts: string[]; from: number; to: number };

function teams(sport: Sport, rows: [string, string, string[]?, number?, number?][]): TeamDef[] {
  return rows.map(([city, nick, alts, from, to]) => ({ sport, city, nick, alts: alts ?? [], from: from ?? 1900, to: to ?? 2100 }));
}

const TEAMS: TeamDef[] = [
  ...teams("baseball", [
    ["Baltimore", "Orioles"], ["Boston", "Red Sox"], ["California", "Angels"], ["Chicago", "White Sox"],
    ["Cleveland", "Indians"], ["Detroit", "Tigers"], ["Kansas City", "Royals"], ["Milwaukee", "Brewers"],
    ["Minnesota", "Twins"], ["New York", "Yankees"], ["Oakland", "Athletics", ["A'S"]], ["Seattle", "Mariners"],
    ["Texas", "Rangers"], ["Toronto", "Blue Jays"], ["Atlanta", "Braves"], ["Chicago", "Cubs"],
    ["Cincinnati", "Reds"], ["Houston", "Astros"], ["Los Angeles", "Dodgers"], ["Montreal", "Expos"],
    ["New York", "Mets"], ["Philadelphia", "Phillies"], ["Pittsburgh", "Pirates"], ["St. Louis", "Cardinals"],
    ["San Diego", "Padres"], ["San Francisco", "Giants"], ["Florida", "Marlins", [], 1993], ["Colorado", "Rockies", [], 1993],
  ]),
  ...teams("basketball", [
    ["Atlanta", "Hawks"], ["Boston", "Celtics"], ["Chicago", "Bulls"], ["Cleveland", "Cavaliers", ["CAVS"]],
    ["Dallas", "Mavericks", ["MAVS"]], ["Denver", "Nuggets"], ["Detroit", "Pistons"], ["Golden State", "Warriors"],
    ["Houston", "Rockets"], ["Indiana", "Pacers"], ["San Diego", "Clippers", [], 1900, 1983], ["Los Angeles", "Clippers", [], 1984],
    ["Los Angeles", "Lakers"], ["Miami", "Heat", [], 1988], ["Milwaukee", "Bucks"], ["Minnesota", "Timberwolves", [], 1989],
    ["New Jersey", "Nets"], ["New York", "Knicks", ["KNICKERBOCKERS"]], ["Orlando", "Magic", [], 1989],
    ["Philadelphia", "76ers", ["SIXERS"]], ["Phoenix", "Suns"], ["Portland", "Trail Blazers", ["BLAZERS"]],
    ["Kansas City", "Kings", [], 1900, 1984], ["Sacramento", "Kings", [], 1985], ["San Antonio", "Spurs"],
    ["Seattle", "SuperSonics", ["SUPER SONICS", "SONICS"]], ["Utah", "Jazz"], ["Washington", "Bullets"],
    ["Charlotte", "Hornets", [], 1988], ["Toronto", "Raptors", [], 1995], ["Vancouver", "Grizzlies", [], 1995],
  ]),
  ...teams("football", [
    ["Atlanta", "Falcons"], ["Buffalo", "Bills"], ["Chicago", "Bears"], ["Cincinnati", "Bengals"], ["Cleveland", "Browns"],
    ["Dallas", "Cowboys"], ["Denver", "Broncos"], ["Detroit", "Lions"], ["Green Bay", "Packers"], ["Houston", "Oilers"],
    ["Baltimore", "Colts", [], 1900, 1983], ["Indianapolis", "Colts", [], 1984], ["Kansas City", "Chiefs"],
    ["Oakland", "Raiders", [], 1900, 1981], ["Los Angeles", "Raiders", [], 1982, 1994], ["Oakland", "Raiders", [], 1995],
    ["Los Angeles", "Rams", [], 1900, 1994], ["St. Louis", "Rams", [], 1995], ["Miami", "Dolphins"], ["Minnesota", "Vikings"],
    ["New England", "Patriots"], ["New Orleans", "Saints"], ["New York", "Giants"], ["New York", "Jets"],
    ["Philadelphia", "Eagles"], ["St. Louis", "Cardinals", [], 1900, 1987], ["Phoenix", "Cardinals", [], 1988, 1993],
    ["Arizona", "Cardinals", [], 1994], ["Pittsburgh", "Steelers"], ["San Diego", "Chargers"],
    ["San Francisco", "49ers", ["FORTY NINERS", "NINERS"]], ["Seattle", "Seahawks"], ["Tampa Bay", "Buccaneers", ["BUCS"]],
    ["Washington", "Redskins"], ["Carolina", "Panthers", [], 1995], ["Jacksonville", "Jaguars", [], 1995],
  ]),
  ...teams("hockey", [
    ["Boston", "Bruins"], ["Buffalo", "Sabres"], ["Calgary", "Flames"], ["Chicago", "Blackhawks", ["BLACK HAWKS"]],
    ["Detroit", "Red Wings"], ["Edmonton", "Oilers"], ["Hartford", "Whalers"], ["Los Angeles", "Kings"],
    ["Minnesota", "North Stars", [], 1900, 1992], ["Dallas", "Stars", [], 1993], ["Montreal", "Canadiens"],
    ["New Jersey", "Devils", [], 1982], ["Colorado", "Rockies", [], 1900, 1981], ["New York", "Islanders"],
    ["New York", "Rangers"], ["Philadelphia", "Flyers"], ["Pittsburgh", "Penguins"], ["Quebec", "Nordiques", [], 1900, 1994],
    ["Colorado", "Avalanche", [], 1995], ["St. Louis", "Blues"], ["Toronto", "Maple Leafs"], ["Vancouver", "Canucks"],
    ["Washington", "Capitals"], ["Winnipeg", "Jets"], ["San Jose", "Sharks", [], 1991], ["Ottawa", "Senators", [], 1992],
    ["Tampa Bay", "Lightning", [], 1992], ["Anaheim", "Mighty Ducks", [], 1993], ["Florida", "Panthers", [], 1993],
  ]),
];

function phraseRe(phrase: string): string {
  return upper(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^ST\\\. /, "(?:ST\\.?|SAINT) ")
    .replace(/ /g, "\\s*");
}

type NickGroup = { key: string; display: string; variants: string[]; entries: TeamDef[] };

const NICK_GROUPS: NickGroup[] = (() => {
  const map = new Map<string, NickGroup>();
  for (const t of TEAMS) {
    const key = upper(t.nick);
    let g = map.get(key);
    if (!g) {
      g = { key, display: t.nick, variants: [t.nick, ...t.alts], entries: [] };
      map.set(key, g);
    }
    g.entries.push(t);
  }
  return [...map.values()];
})();

type Variant = { group: NickGroup; re: RegExp; len: number };

const VARIANTS: Variant[] = NICK_GROUPS.flatMap((g) =>
  g.variants.map((v) => ({ group: g, re: new RegExp(`\\b${phraseRe(v)}\\b`, "g"), len: v.length })),
).sort((a, b) => b.len - a.len);

const CITY_RES = new Map<string, RegExp>(TEAMS.map((t) => [t.city, new RegExp(`\\b${phraseRe(t.city)}\\b`)]));

/** Words that look like a nickname but are something else in context. */
function excludedNick(key: string, before: string, after: string): boolean {
  if (key === "STARS" && /(?:ALL|FUTURE|RISING)[\s-]*$/.test(before)) return true;
  if (key === "MAGIC" && /^\s*JOHNSON/.test(after)) return true;
  if (key === "KINGS" && /DIAMOND\s*$/.test(before)) return true;
  return false;
}

type TeamFind = { team: string; sport: Sport | null; ambiguous: boolean; line: Line; /** Read with one letter wrong or missing. */ fuzzy: boolean };

/**
 * Close spellings of team nicknames ("MARMNERS" for Mariners). Since 10.10
 * a close spelling is only ever a hint, never written as the team. Kept
 * narrow on purpose, because surnames and plain words sit one letter away
 * from many nicknames (Brewer, Brown, Falcone, Pilates):
 * - only one word nicknames of 6 or more letters, and the read word must be
 *   in capitals, 6 or more letters, and start with the same letter;
 * - one letter wrong (same length) where the two letters look alike to the
 *   text reader (I and M, E and F, O and Q, C and G), never the last letter;
 *   or one letter left out, but never one of the last two letters ("BREWER",
 *   "MARINES"). No added letters;
 * - never a word from FUZZY_STOP, never a word on a line that gave a player
 *   name candidate, and only when exactly one nickname is that close;
 * - only when no team was read exactly.
 */
const FUZZY_MIN_LETTERS = 6;
const FUZZY_WEIGHT = 0.5;

/** Names and plain words that are one letter away from a nickname. */
const FUZZY_STOP = new Set([
  // Singular nicknames, which are also surnames and plain words.
  "BREWER", "BROWN", "GIANT", "TIGER", "RANGER", "ROYAL", "BRAVE", "RAIDER", "CARDINAL", "INDIAN", "LAKER", "PIRATE",
  "ROCKET", "DODGER", "PACKER", "PACER", "ANGEL", "SAINT", "EAGLE", "FLAME", "FLYER", "OILER", "BULLET", "VIKING",
  "MARINER", "CAPITAL", "CAPITOL", "CAPITOLS", "SENATOR", "PATRIOT", "PANTHER", "CHARGER", "STEELER", "COWBOY", "BRONCO",
  // Card words.
  "ROOKIE", "ROOKIES",
  // Surnames and places.
  "PHILLIPS", "MARTINS", "MARINS", "MERLINS", "RODGERS", "GRAVES", "SPARKS", "BROWNE", "GRANTS", "ANGELO", "ANGELA",
  "INDIANA", "PARKERS", "BAKERS", "WALKERS", "POWERS", "ROGERS", "RIDERS", "ROYALE", "CANADIANS", "MARINES",
  "FALCONE", "ANGELL", "DEVINS", "RADERS",
  // Plain words.
  "MINERS", "MAKERS", "TAKERS", "DINERS", "LINERS", "LASERS", "LAYERS", "PAPERS", "TIMERS", "PICKERS", "PACKETS",
  "RACKETS", "ROCKERS", "POCKETS", "RINGERS", "DANGERS", "CHANGERS", "CHARTERS", "CHARGES", "RANGES", "DODGES",
  "BLAZES", "WHALES", "STEALERS", "PISTOLS", "PITONS", "KNOCKS", "BRAINS", "BRAKES", "BRACES", "BREWERY", "ANGERS",
  "SHARES", "SHARPS", "SHANKS", "FRAMES", "FLAKES", "FLARES", "FLIERS", "FOYERS", "SABLES", "CROWNS", "BALLETS",
  "BILLETS", "LIGHTING", "PILATES", "CHARMERS", "FRYERS", "PAGERS", "SHACKS",
]);

/** Letters the text reader mixes up in capitals: a wrong letter counts only inside one group. */
const LOOK_ALIKE = ["ILTJ", "MNHWI", "OQDCGU", "EF", "UV", "KX", "PB", "RK"];

function lookAlike(a: string, b: string): boolean {
  return LOOK_ALIKE.some((g) => g.includes(a) && g.includes(b));
}

/** True when the read word is the nickname with one look alike letter wrong (not the last), or one letter (not one of the last two) left out. */
function closeSpelling(word: string, nick: string): boolean {
  if (word === nick || word[0] !== nick[0]) return false;
  let i = 0;
  while (i < word.length && word[i] === nick[i]) i++;
  if (word.length === nick.length) {
    return i < word.length - 1 && lookAlike(word[i], nick[i]) && word.slice(i + 1) === nick.slice(i + 1);
  }
  if (word.length !== nick.length - 1) return false;
  return word.slice(i) === nick.slice(i + 1) && i < nick.length - 2;
}

const FUZZY_NICKS: { group: NickGroup; word: string }[] = NICK_GROUPS.flatMap((g) =>
  g.variants.map((v) => ({ group: g, word: upper(v) })).filter((v) => new RegExp(`^[A-Z]{${FUZZY_MIN_LETTERS},}$`).test(v.word)),
);

function fuzzyNick(word: string): NickGroup | null {
  if (word.length < FUZZY_MIN_LETTERS || FUZZY_STOP.has(word)) return null;
  const hits = new Set(FUZZY_NICKS.filter((n) => closeSpelling(word, n.word)).map((n) => n.group));
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Nicknames that are also plain words or names ("TOPPS STARS", "BRINGS THE
 * HEAT", "JEFF KINGS", "LSU TIGERS"). They count only on a team line (see
 * teamLine), never as a hint from other text.
 */
const PLAIN_NICKS = new Set([
  "STARS", "BEARS", "MAGIC", "HEAT", "BILLS", "KINGS", "JETS", "TIGERS", "SUNS", "JAZZ", "NETS", "BLUES", "GIANTS",
  "SAINTS", "LIGHTNING", "FLAMES", "DEVILS", "LIONS", "RAMS", "SHARKS", "SPURS", "BUCKS", "CHIEFS", "ROYALS",
  "ANGELS", "BRAVES", "REDS", "CUBS", "TWINS", "PANTHERS", "EAGLES", "HAWKS", "CAPITALS", "BULLETS", "ROCKETS",
  "PISTONS", "WARRIORS", "CLIPPERS", "SENATORS", "PENGUINS", "WHALERS", "OILERS", "FLYERS", "AVALANCHE", "SABRES",
  "ATHLETICS", "INDIANS", "BROWNS", "PACKERS", "STEELERS", "CHARGERS", "RAIDERS", "VIKINGS", "COWBOYS", "BRONCOS",
  "PATRIOTS", "RANGERS", "PIRATES", "CARDINALS", "COLTS", "JAGUARS", "DOLPHINS", "GRIZZLIES", "HORNETS", "BULLS",
  "ROCKIES", "MARLINS", "EXPOS", "ASTROS", "PADRES", "ISLANDERS", "CANUCKS", "NORDIQUES", "FALCONS", "BENGALS",
  "SAINTS", "BUCCANEERS", "SEAHAWKS", "MAVERICKS", "NUGGETS", "PACERS", "CELTICS", "LAKERS",
]);

/** Words that may stand on a team line beside the team: positions (the position lists come later in this file). */
const TEAM_LINE_WORDS = () => new Set([
  ...Object.keys(POS_TOKENS), ...Object.keys(SINGLE_POS), "PITCHER", "CATCHER", "OUTFIELD", "OUTFIELDER", "INFIELD",
  "INFIELDER", "SHORTSTOP", "FIRST", "SECOND", "THIRD", "BASE", "BASEMAN", "DESIGNATED", "HITTER", "QUARTERBACK",
  "RUNNING", "BACK", "WIDE", "RECEIVER", "TIGHT", "END", "LINEBACKER", "CORNERBACK", "DEFENSIVE", "SAFETY", "TACKLE",
  "KICKER", "PUNTER", "LEFT", "RIGHT", "WING", "DEFENSEMAN", "GOALIE", "GOALTENDER", "GUARD", "FORWARD", "CENTER",
]);

const CITY_RES_ALL = new Map<string, RegExp>(TEAMS.map((t) => [t.city, new RegExp(`\\b${phraseRe(t.city)}\\b`, "g")]));

/** The read nickname is in capitals or starts each word with one ("MARINERS", "Mariners"), not "twins". */
function capitalized(raw: string): boolean {
  const words = raw.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => /^[A-Z0-9]/.test(w));
}

/**
 * A team line: besides the team (with or without its city) only positions,
 * numbers and marks ("SEATTLE MARINERS OF", "OUTFIELD MARINERS", "BULLS
 * GUARD", a stat row "89 YANKEES 127 455 61"). Not "TOPPS STARS", "JEFF
 * KINGS", "KINGS MOUNTAIN" or "A MAGIC MOMENT".
 */
let teamLineWords: Set<string> | null = null;

function teamLine(l: Line, start: number, end: number, group: NickGroup): boolean {
  const words = (teamLineWords ??= TEAM_LINE_WORDS());
  let rest = upper(`${l.raw.slice(0, start)} ${l.raw.slice(end)}`);
  for (const t of group.entries) rest = rest.replace(CITY_RES_ALL.get(t.city)!, " ");
  return rest
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ""))
    .filter(Boolean)
    .every((w) => /^'?[\d.,%#'/-]+$/.test(w) || words.has(w));
}

type TeamScore = { score: number; line: Line };
type TeamRow = { group: NickGroup; season: number; y: number };
type TeamTally = { scores: Map<NickGroup, TeamScore>; lastRow: TeamRow | null };

function newTally(): TeamTally {
  return { scores: new Map(), lastRow: null };
}

function tallyTeam(tally: TeamTally, group: NickGroup, l: Line) {
  const cur = tally.scores.get(group) ?? { score: 0, line: l };
  cur.score += 1 + (l.side === "front" ? 1 : 0) + (l.tokens.length <= 4 ? 1 : 0);
  tally.scores.set(group, cur);
  // Stat table rows ("89 MARINERS"): the latest season's club is the card's team.
  const season = rowSeason(l.tokens[0] ?? "");
  const last = tally.lastRow;
  if (season != null && l.tokens.length >= 2 && (!last || season > last.season || (season === last.season && l.box.y >= last.y))) {
    tally.lastRow = { group, season, y: l.box.y };
  }
}

/** The best scored nickname of a tally, or null. */
function bestOf(tally: TeamTally, lines: Line[]): { group: NickGroup; line: Line } | null {
  const scores = tally.scores;
  if (tally.lastRow) {
    const cur = scores.get(tally.lastRow.group);
    if (cur) cur.score += 5;
  }
  const all = lines.map((l) => l.lz).join("\n");
  let best: { group: NickGroup; line: Line } | null = null;
  let top = -1;
  for (const [g, s] of scores) {
    const total = s.score + (g.entries.some((t) => CITY_RES.get(t.city)?.test(all) ?? false) ? 2 : 0);
    if (total > top) {
      top = total;
      best = { group: g, line: s.line };
    }
  }
  return best;
}

/** The team a nickname stands for, settled by the city read, the year and the sport clues. */
function resolveTeam(group: NickGroup, line: Line, lines: Line[], year: number | null, sportHint: Sport | null, fuzzy: boolean): TeamFind {
  const all = lines.map((l) => l.lz).join("\n");
  const cityHit = (t: TeamDef) => CITY_RES.get(t.city)?.test(all) ?? false;
  let entries = group.entries;
  if (year != null) {
    const inYear = entries.filter((t) => year >= t.from - 1 && year <= t.to + 1);
    if (inYear.length > 0) entries = inYear;
  }
  const withCity = entries.filter(cityHit);
  if (withCity.length > 0) entries = withCity;
  const sports = new Set(entries.map((t) => t.sport));
  if (sports.size > 1 && sportHint) {
    const hinted = entries.filter((t) => t.sport === sportHint);
    if (hinted.length > 0) entries = hinted;
  }
  if (new Set(entries.map((t) => t.sport)).size > 1) return { team: group.display, sport: null, ambiguous: true, line, fuzzy };
  let pick = entries[entries.length - 1];
  if (year != null) pick = entries.find((t) => year >= t.from && year <= t.to) ?? pick;
  return { team: `${pick.city} ${pick.nick}`, sport: pick.sport, ambiguous: false, line, fuzzy };
}

/**
 * Team reading (10.10). Text alone is a weak clue, so:
 * - `team` (written into the item) only when one nickname was read exactly,
 *   in capitals, on a team line that is not a sentence, and no other team
 *   was read anywhere on the card (exactly in capitals, or a close spelling);
 * - otherwise the best reading is only a `hint`: an exact nickname in
 *   capitals elsewhere (not a plain word nickname off a team line, not on a
 *   name line), else a close spelling. The recognizer writes a hint only
 *   when the player's Wikidata team list has it.
 * Nicknames in lower case ("the twins", "He bears down") are ignored.
 * A hint whose sport differs from the position read is dropped.
 */
function findTeam(
  lines: Line[],
  year: number | null,
  sportHint: Sport | null,
  nameLines: ReadonlySet<Line>,
  position: PosFind | null,
): { team: TeamFind | null; hint: TeamFind | null } {
  const strong = newTally();
  const exact = newTally();
  const close = newTally();
  const read = new Set<NickGroup>();
  for (const l of lines) {
    let work = l.lz;
    const sentence = isSentence(l);
    for (const v of VARIANTS) {
      v.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = v.re.exec(work)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        work = work.slice(0, start) + " ".repeat(end - start) + work.slice(end);
        v.re.lastIndex = end;
        if (excludedNick(v.group.key, l.lz.slice(0, start), l.lz.slice(end))) continue;
        if (!capitalized(l.raw.slice(start, end))) continue;
        const onTeamLine = teamLine(l, start, end, v.group);
        if (!onTeamLine && (PLAIN_NICKS.has(v.group.key) || nameLines.has(l))) continue;
        read.add(v.group);
        tallyTeam(exact, v.group, l);
        if (onTeamLine && !sentence) tallyTeam(strong, v.group, l);
      }
    }
    if (nameLines.has(l)) continue;
    // Whole words in capitals that missed a nickname by one letter.
    const word = /[A-Z]+/g;
    let m: RegExpExecArray | null;
    while ((m = word.exec(work)) !== null) {
      if (l.raw.slice(m.index, m.index + m[0].length) !== m[0]) continue;
      const group = fuzzyNick(m[0]);
      if (group) {
        read.add(group);
        tallyTeam(close, group, l);
      }
    }
  }
  if (read.size === 1 && strong.scores.size === 1) {
    const [group] = [...strong.scores.keys()];
    return { team: resolveTeam(group, strong.scores.get(group)!.line, lines, year, sportHint, false), hint: null };
  }
  const fuzzy = exact.scores.size === 0;
  const best = bestOf(fuzzy ? close : exact, lines);
  if (!best) return { team: null, hint: null };
  const hint = resolveTeam(best.group, best.line, lines, year, sportHint ?? position?.sport ?? null, fuzzy);
  // "COWBQYS" with the baseball position SS: not a hint.
  const sports = new Set(best.group.entries.map((t) => t.sport));
  if (position?.sport && !sports.has(position.sport)) return { team: null, hint: null };
  if (position?.sport && hint.sport && hint.sport !== position.sport) return { team: null, hint: null };
  return { team: null, hint };
}

// ---------------------------------------------------------------------------
// Sport clues

type Votes = Map<Sport, number>;

function vote(v: Votes, s: Sport | null | undefined, w: number) {
  if (s && w > 0) v.set(s, (v.get(s) ?? 0) + w);
}

function winner(v: Votes): Sport | null {
  let best: Sport | null = null;
  let bestW = 0;
  let tie = false;
  for (const [s, w] of v) {
    if (w > bestW) {
      best = s;
      bestW = w;
      tie = false;
    } else if (w === bestW) tie = true;
  }
  return tie ? null : best;
}

const LEAGUE_WORDS: [RegExp, Sport][] = [
  [/\bNATIONAL\s*HOCKEY\s*LEAGUE\b|\bNHL\b|\bNHLPA\b|\bHOCKEY\b/, "hockey"],
  [/\bNATIONAL\s*BASKETBALL\b|\bNBA\b|\bBASKETBALL\b/, "basketball"],
  [/\bNATIONAL\s*FOOTBALL\s*LEAGUE\b|\bNFL\b|\bNFLPA\b|\bUSFL\b|\bFOOTBALL\b/, "football"],
  [/\bMAJOR\s*LEAGUE\b(?!\s*MARKETING)|\bMLB\b|\bMLBPA\b|\bAMERICAN\s*LEAGUE\b|\bNATIONAL\s*LEAGUE\b|\bBASEBALL\b/, "baseball"],
];

const STAT_WORDS: Record<"baseball" | "basketball" | "football" | "hockey", string[]> = {
  baseball: ["RBI", "ERA", "AB", "HR", "SB", "IP", "SLG", "OBP", "2B", "3B"],
  basketball: ["FGA", "FTA", "REB", "AST", "STL", "BLK", "FG%", "FT%", "PCT"],
  football: ["YDS", "TD", "TDS", "RUSHING", "RECEIVING", "PASSING", "SACKS", "COMP"],
  hockey: ["PIM", "PPG", "SHG", "GWG", "GAA", "+/-"],
};

function leagueAndStatVotes(lines: Line[], v: Votes) {
  const all = lines.map((l) => l.lz).join("\n");
  for (const [re, s] of LEAGUE_WORDS) if (re.test(all)) vote(v, s, 2);
  const tokens = new Set(lines.flatMap((l) => (l.tokens.length >= 3 ? l.up.split(" ") : [])));
  for (const [s, words] of Object.entries(STAT_WORDS) as [Sport, string[]][]) {
    const found = words.filter((w) => tokens.has(w)).length;
    if (found >= 2) vote(v, s, 2);
    else if (found === 1) vote(v, s, 0.5);
  }
}

// ---------------------------------------------------------------------------
// Positions

const POS_TOKENS: Record<string, Sport | null> = {
  "1B": "baseball", "2B": "baseball", "3B": "baseball", SS: "baseball", OF: "baseball", DH: "baseball",
  LHP: "baseball", RHP: "baseball", INF: "baseball", IF: "baseball", CF: "baseball", LF: "baseball", RF: "baseball",
  QB: "football", RB: "football", WR: "football", TE: "football", LB: "football", DB: "football", DE: "football",
  DT: "football", CB: "football", FB: "football", OT: "football", OG: "football", NT: "football", OL: "football",
  LW: "hockey", RW: "hockey",
};
const SINGLE_POS: Record<string, Sport | null> = { P: "baseball", C: null, G: null, F: "basketball", D: "hockey" };

const POS_WORDS: [RegExp, string, Sport | null][] = [
  [/\bFIRST\s*BASE(?:MAN)?\b/, "1B", "baseball"],
  [/\bSECOND\s*BASE(?:MAN)?\b/, "2B", "baseball"],
  [/\bTHIRD\s*BASE(?:MAN)?\b/, "3B", "baseball"],
  [/\bSHORTSTOP\b/, "SS", "baseball"],
  [/\bOUTFIELD(?:ER)?\b/, "OF", "baseball"],
  [/\bINFIELD(?:ER)?\b/, "IF", "baseball"],
  [/\bPITCHER\b/, "P", "baseball"],
  [/\bCATCHER\b/, "C", "baseball"],
  [/\bDESIGNATED\s*HITTER\b/, "DH", "baseball"],
  [/\bQUARTERBACK\b/, "QB", "football"],
  [/\bRUNNING\s*BACK\b/, "RB", "football"],
  [/\bWIDE\s*RECEIVER\b/, "WR", "football"],
  [/\bTIGHT\s*END\b/, "TE", "football"],
  [/\bLINEBACKER\b/, "LB", "football"],
  [/\bCORNERBACK\b/, "CB", "football"],
  [/\bDEFENSIVE\s*END\b/, "DE", "football"],
  [/\bLEFT\s*WING\b/, "LW", "hockey"],
  [/\bRIGHT\s*WING\b/, "RW", "hockey"],
  [/\bDEFENSEMAN\b/, "D", "hockey"],
  [/\bGOAL(?:IE|TENDER)\b/, "G", "hockey"],
  [/\bGUARD\b/, "G", "basketball"],
  [/\bFORWARD\b/, "F", "basketball"],
  [/\bCENTER\b/, "C", null],
];

type PosFind = { position: string; sport: Sport | null };

function posFromToken(tok: string, singleOk: boolean): PosFind | null {
  const t = tok.replace(/[.,:;]+$/, "");
  if (t !== t.toUpperCase()) return null;
  if (t in POS_TOKENS) return { position: t, sport: POS_TOKENS[t] };
  if (singleOk && t in SINGLE_POS) return { position: t, sport: SINGLE_POS[t] };
  const parts = t.split(/[-/]/);
  if (parts.length >= 2 && parts.every((p) => p in POS_TOKENS || p in SINGLE_POS)) {
    const sports = new Set(parts.map((p) => POS_TOKENS[p] ?? SINGLE_POS[p]).filter(Boolean));
    let sport: Sport | null = sports.size === 1 ? ([...sports][0] as Sport) : null;
    if (parts.every((p) => ["G", "F", "C"].includes(p))) sport = "basketball";
    return { position: t, sport };
  }
  return null;
}

function findPosition(lines: Line[]): PosFind | null {
  for (const l of lines) {
    const t = l.tokens;
    const posIdx = t.findIndex((x) => /^POS(?:ITION)?[.:]?$/i.test(x));
    if (posIdx >= 0) {
      const p = posFromToken(t[posIdx + 1] ?? "", true);
      if (p) return p;
    }
    if (t.length > 6) continue;
    for (let i = 0; i < t.length; i++) {
      const singleOk = t.length <= 4 && i === t.length - 1;
      const p = posFromToken(t[i], singleOk);
      if (p) return p;
    }
  }
  for (const l of lines) {
    if (l.tokens.length > 6) continue;
    for (const [re, position, sport] of POS_WORDS) if (re.test(l.lz)) return { position, sport };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Players

const SUFFIXES: Record<string, string> = { JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV" };

const STOP_WORDS = new Set(
  [
    // Brands and sets
    "TOPPS", "FLEER", "DONRUSS", "SCORE", "UPPER", "DECK", "BOWMAN", "OPEECHEE", "OPC", "PEE", "CHEE", "LEAF", "PRO", "SET",
    // Autograph, slab and product words seen on real card fronts and labels
    "AUTO", "AUTOS", "AUTOGRAPH", "AUTOGRAPHED", "AUTOGRAPHS", "AUTHENTICATED", "SIGNATURE", "SIGNATURES", "SIGNED",
    "CERTIFIED", "GRADE", "GRADED", "REPRINT", "DNA", "HEROES", "PRESENTS", "CHAMPIONS", "COLLECTION", "EDITION",
    "LIMITED", "SPECIAL", "INSERT", "PARALLEL", "REFRACTOR", "VINTAGE", "SWEET", "SPOT", "GOODWIN", "BASEBALL",
    "BASKETBALL", "FOOTBALL", "HOCKEY", "ROOKIES", "SERIES",
    "HOOPS", "SKYBOX", "SKY", "BOX", "STADIUM", "CLUB", "ULTRA", "PINNACLE", "CLASSIC", "STAR", "STARS", "PACIFIC",
    "ACTION", "PACKED", "CARDS", "KELLOGGS", "DRAKES", "PARKHURST", "TRADED", "UPDATE", "ROOKIE", "ROOKIES", "TIFFANY",
    "GLOSSY", "SUPPLEMENTAL", "SP", "MINOR", "STICKER", "STICKERS",
    // Card words
    "BATS", "THROWS", "HEIGHT", "WEIGHT", "HT", "WT", "BORN", "HOME", "DRAFTED", "ACQUIRED", "SIGNED", "FREE", "AGENT",
    "MAJOR", "LEAGUE", "LEAGUES", "BATTING", "PITCHING", "FIELDING", "RECORD", "RECORDS", "TOTALS", "TOTAL", "CAREER",
    "SEASON", "YEAR", "YEARS", "RUSHING", "RECEIVING", "PASSING", "SCORING", "DEFENSE", "COMPLETE", "RIGHT", "LEFT",
    "RATED", "FUTURE", "ALL", "DRAFT", "PICK", "PROSPECT", "PROSPECTS", "TEAM", "LEADERS", "LEADER", "BREAKER",
    "CHECKLIST", "DIAMOND", "KINGS", "PRINTED", "USA", "INC", "CORP", "CO", "LTD", "COMPANY", "CHEWING", "GUM",
    "PROPERTIES", "OFFICIALLY", "LICENSED", "PLAYERS", "PLAYER", "ASSOCIATION", "CARD", "NO", "NUMBER", "THE", "AND",
    "OF", "IN", "TO", "HIS", "HE", "FOR", "WITH", "AT", "BY", "ON", "IS", "AS", "FROM", "WAS", "HAS", "HAD", "AN", "OR",
    "BUT", "WHO", "ALSO", "AFTER", "BEFORE", "LAST", "BEST", "MOST", "TOP", "ROUND", "OVERALL", "GAMES", "GAME", "HITS",
    "RUNS", "WINS", "POINTS", "GOALS", "ASSISTS", "YARDS", "COPYRIGHT", "RESERVED", "RIGHTS", "MADE", "CANADA",
    "BASEBALL", "BASKETBALL", "FOOTBALL", "HOCKEY", "NATIONAL", "AMERICAN", "MLB", "NFL", "NBA", "NHL", "USFL",
    "MLBPA", "NFLPA", "NHLPA", "OLYMPIC", "UNIVERSITY", "COLLEGE", "SCHOOL", "HIGH", "ACADEMY",
    // School words, so "Oklahoma State" or "Texas Tech" is not read as a player.
    "STATE", "TECH", "A&M", "INSTITUTE", "SERIES", "WORLD", "HIGHLIGHTS", "HIGHLIGHT", "MVP", "AWARD", "CYCLE",
    // Stat headers
    "AVG", "RBI", "ERA", "AB", "HR", "SB", "IP", "BB", "SO", "SLG", "PCT", "REB", "AST", "PTS", "FGA", "FTA", "GP",
    "PIM", "YDS", "TD", "TDS", "ATT", "INT", "REC", "LG", "MIN", "STL", "BLK", "GAA", "PPG",
    // Grades and graders
    "PSA", "BGS", "SGC", "CGC", "BECKETT", "GRADING", "MINT", "GEM", "MT", "NM", "EX", "VG", "GOOD", "FAIR", "POOR",
    "PRISTINE", "AUTHENTIC", "CERT", "CERTIFICATION",
    // Positions
    ...Object.keys(POS_TOKENS), "PITCHER", "CATCHER", "OUTFIELD", "OUTFIELDER", "INFIELD", "INFIELDER", "SHORTSTOP",
    "BASE", "BASEMAN", "QUARTERBACK", "RECEIVER", "LINEBACKER", "CORNERBACK", "WING", "DEFENSEMAN", "GOALIE",
    "GOALTENDER", "GUARD", "FORWARD", "CENTER", "BACK", "END", "TIGHT", "WIDE", "RUNNING",
    // Team nickname words
    "SOX", "JAYS", "WINGS", "LEAFS", "BLAZERS", "DUCKS", "HAWKS", "NINERS", "SONICS", "CAVS", "MAVS", "BUCS",
    // "Magic" stays out: it is also Magic Johnson's name.
    ...NICK_GROUPS.filter((g) => !g.key.includes(" ") && g.key !== "MAGIC").map((g) => g.key.replace(/[^A-Z0-9]/g, "")),
  ].map((w) => w.replace(/[^A-Z0-9%]/g, "")),
);

const CITY_KEYS = new Set(TEAMS.map((t) => normalizeName(t.city)));

const KEY_PLAYERS = new Map<string, string>(KEY_CARDS.map((k) => [normalizeName(k.player), k.player]));

type NameWord = { word: string; key: string; initials: boolean };

/**
 * OCR on busy fronts produces short letter groups ("Ert Arn", "Heroes Fv").
 * A real name has a vowel in every word and at least one word of 4 or more
 * letters ("Bo Jackson", "Cal Ripken").
 */
function looksLikeName(core: NameWord[]): boolean {
  const words = core.filter((w) => !w.initials).map((w) => w.key);
  if (words.length === 0) return false;
  if (!words.every((w) => /[AEIOUY]/.test(w))) return false;
  if (!words.some((w) => w.length >= 4)) return false;
  // Two consonants and nothing else, or a doubled junk tail, are OCR noise.
  return words.every((w) => !/^[^AEIOUY]{3,}$/.test(w) && !/(.)\1\1/.test(w));
}

function nameWord(tok: string): NameWord | null {
  let s = tok.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9.']+$/, "");
  if (!s) return null;
  const letters = s.replace(/[^A-Za-z]/g, "");
  const ups = letters.replace(/[^A-Z]/g, "").length;
  if (s.length >= 3 && letters.length >= 2 && ups / Math.max(letters.length, 1) >= 0.6 && /[01|5l]/.test(s)) {
    const digits = (s.match(/\d/g) ?? []).length;
    if (digits <= 2) s = s.replace(/0/g, "O").replace(/[1|l]/g, "I").replace(/5/g, "S");
  }
  if (/^(?:[A-Za-z]\.){1,3}$/.test(s)) return { word: s.toUpperCase(), key: s.toUpperCase().replace(/\./g, ""), initials: true };
  if (!/^[A-Za-z][A-Za-z'-]*[A-Za-z]\.?$/.test(s)) return null;
  const word = s.replace(/\.$/, "");
  return { word, key: word.toUpperCase().replace(/[^A-Z]/g, ""), initials: false };
}

function titleWord(w: string): string {
  if (/^(?:[A-Za-z]\.)+$/.test(w)) return w.toUpperCase();
  return w
    .split("-")
    .map((part) =>
      part
        .split("'")
        .map((p) => {
          const low = p.toLowerCase();
          if (!low) return low;
          if (/^mc[a-z]{2,}/.test(low)) return `Mc${low[2].toUpperCase()}${low.slice(3)}`;
          return low[0].toUpperCase() + low.slice(1);
        })
        .join("'"),
    )
    .join("-");
}

type Candidate = { name: string; score: number };

/** Removes team names with a city ("Chicago White Sox") so the city is not read as a name. */
const MASK_RES: RegExp[] = TEAMS.flatMap((t) =>
  [t.nick, ...t.alts].map((v) => new RegExp(`\\b(?:${phraseRe(t.city)}\\s*)?${phraseRe(v)}\\b`, "g")),
);

function maskTeams(l: Line): string[] {
  let work = l.lz;
  for (const re of MASK_RES) work = work.replace(re, (m) => " ".repeat(m.length));
  let out = "";
  for (let i = 0; i < l.raw.length; i++) out += work[i] === " " ? " " : l.raw[i];
  return out.split(" ").filter(Boolean);
}

/** Lowercase words that make a line of 6 or more words a sentence. */
const VERBS = new Set([
  "is", "was", "were", "has", "had", "have", "be", "been", "became", "becomes", "led", "leads", "hit", "hits", "won",
  "wins", "set", "sets", "made", "makes", "tied", "ties", "joined", "went", "came", "took", "got", "threw", "ran",
  "stole", "struck", "batted", "pitched", "played", "plays", "scored", "signed", "drafted", "graduated", "attended",
  "starred", "earned", "finished", "ranked", "named", "selected", "traded", "acquired", "spent", "appeared", "posted",
  "recorded", "collected", "helped", "began", "started", "returned", "missed", "suffered", "owns", "holds", "held",
]);

/** Small words inside names, written in lower case: "de", "van", "st". */
const NAME_PARTICLES = new Set(["de", "da", "del", "di", "la", "le", "van", "von", "der", "st"]);

/**
 * A bio sentence, not a name line: a capitalized word followed by a word in
 * lower case ("Ken graduated", "Bo played"), or 6 or more words with a verb
 * in lower case or a full stop at the end.
 */
function isSentence(l: Line): boolean {
  const t = l.tokens;
  for (let i = 1; i < t.length; i++) {
    if (/^[A-Z][a-zA-Z'-]*[a-zA-Z]$/.test(t[i - 1]) && /^[a-z][a-z'-]+[.,;:!?]?$/.test(t[i])) {
      // "Jose de Jesus", "Andy van Slyke": a small name word before a capitalized word is part of a name.
      if (NAME_PARTICLES.has(t[i].replace(/[.,;:!?]+$/, "")) && /^[A-Z]/.test(t[i + 1] ?? "")) continue;
      return true;
    }
  }
  if (t.length < 6) return false;
  if (/\.$/.test(l.raw) && !/\b(?:JR|SR|[A-Z])\.$/i.test(l.raw)) return true;
  return t.some((w) => VERBS.has(w.replace(/[.,;:!?]+$/, "")));
}

/** "Ken" from "Ken graduated from Moeller": the first word of a sentence, when it looks like a first name. */
function firstNameOf(l: Line): string | null {
  const w = nameWord(l.tokens[0] ?? "");
  if (!w || w.initials || !/^[A-Z][a-z]+$/.test(w.word) || STOP_WORDS.has(w.key)) return null;
  return looksLikeName([w]) || /^[A-Z][a-z]{1,2}$/.test(w.word) ? w.word : null;
}

/** A position token for the header pattern, any sport: "OF", "SS", "1B", "C", "G", "LW". */
function headerPosition(tok: string): PosFind | null {
  const t = tok.replace(/[^A-Za-z0-9/-]+$/, "");
  return posFromToken(t, true);
}

/**
 * The header on many card backs: name, an optional suffix, a dot, bullet,
 * dash or space, then the position. "Ken Griffey, Jr. * OF",
 * "CAL RIPKEN, JR. SS". A stray mark or two before the name is allowed.
 */
function headerName(l: Line): { words: NameWord[]; suffix: string | null; pos: PosFind } | null {
  const t = l.tokens.filter((x) => /[A-Za-z0-9]/.test(x));
  if (t.length < 3 || t.length > 7) return null;
  const pos = headerPosition(t[t.length - 1]);
  if (!pos) return null;
  let end = t.length - 1;
  let suffix: string | null = null;
  const suf = /^([A-Za-z]{2,3})\.?[^A-Za-z0-9]*$/.exec(t[end - 1] ?? "");
  if (suf && upper(suf[1]) in SUFFIXES) {
    suffix = SUFFIXES[upper(suf[1])];
    end--;
  }
  // Up to 3 name words before the suffix, each starting with a capital.
  const words: NameWord[] = [];
  let k = end - 1;
  while (k >= 0 && words.length < 3) {
    const tok = t[k];
    if (!/^[A-Z]/.test(tok)) break;
    const w = nameWord(tok.replace(/[,.]+$/, ""));
    if (!w || w.initials || STOP_WORDS.has(w.key) || w.key in SUFFIXES) break;
    words.unshift(w);
    k--;
  }
  // Only stray marks of one or two characters may come before the name.
  if (words.length < 2 || !looksLikeName(words) || CITY_KEYS.has(normalizeName(words.map((w) => w.word).join(" ")))) return null;
  for (let j = 0; j <= k; j++) if (t[j].length > 2) return null;
  return { words, suffix, pos };
}

/** Band lines are read on their own from a strip: a name in capitals there is a headline. */
const BAND_NAME_BONUS = 10;
/** The header pattern is the strongest name clue on a card back, short of the key card list. */
const HEADER_NAME_BONUS = 15;

function findPlayers(
  front: Line[],
  back: Line[],
): { names: string[]; keyMatch: string | null; hint: string | null; header: PosFind | null; nameLines: Set<Line> } {
  const found = new Map<string, Candidate>();
  /** Every line a name candidate was read from, so its words are not also tried as a team. */
  const nameLines = new Set<Line>();
  let keyMatch: string | null = null;
  let hint: string | null = null;
  let header: PosFind | null = null;
  for (const l of [...front, ...back]) {
    // A name is never taken from a sentence; its first word may be a first name hint.
    if (isSentence(l)) {
      hint = hint ?? firstNameOf(l);
      continue;
    }
    const head = headerName(l);
    if (head) {
      nameLines.add(l);
      header = header ?? head.pos;
      let name = [...head.words.map((w) => titleWord(w.word)), ...(head.suffix ? [head.suffix] : [])].join(" ");
      const nk = normalizeName(name);
      let score = 1 + HEADER_NAME_BONUS + Math.min(Math.max(l.conf, 0), 1);
      const canonical = KEY_PLAYERS.get(nk);
      if (canonical) {
        score += 20;
        name = canonical;
        keyMatch = keyMatch ?? canonical;
      }
      const prev = found.get(nk);
      if (!prev || prev.score < score) found.set(nk, { name, score });
    }
    // Long lines are sentences, except a slab label that packs everything on one line.
    if (l.tokens.length > 8 && !GRADE_RE.test(l.up) && !/#\s*\d/.test(l.raw)) continue;
    // Lines with labels ("BORN:", "HOME:") hold places and dates, not the name.
    if (l.tokens.some((t) => /[A-Za-z]:$/.test(t))) continue;
    const tokens = maskTeams(l);
    const lineWords = l.tokens.length;
    let run: NameWord[] = [];
    let suffix: string | null = null;
    const flush = () => {
      // Drop vowel-less OCR scraps at either end ("ALEX RODRIGUEZ GML").
      let core = run;
      while (core.length > 0 && !core[core.length - 1].initials && !/[AEIOUY]/.test(core[core.length - 1].key)) core = core.slice(0, -1);
      while (core.length > 0 && !core[0].initials && !/[AEIOUY]/.test(core[0].key)) core = core.slice(1);
      if (core.length >= 2 && core.length <= 3 && !core.every((w) => w.initials) && looksLikeName(core)) {
        const plainKey = normalizeName(core.map((w) => w.word).join(" "));
        if (!CITY_KEYS.has(plainKey)) {
          nameLines.add(l);
          const words = core.map((w) => titleWord(w.word));
          if (suffix) words.push(suffix);
          let name = words.join(" ");
          const nk = normalizeName(name);
          const canonical = KEY_PLAYERS.get(nk);
          let score = 1 + Math.min(Math.max(l.conf, 0), 1);
          if (l.side === "front") score += 2 + (l.box.y < 0.35 ? 1 : 0);
          else if (l.box.y < 0.3) score += 1;
          score += Math.min(Math.max(l.box.h, 0), 0.2) * 10;
          if (core.length + (suffix ? 1 : 0) === lineWords) score += 1;
          if (l.source === "band" && core.every((w) => w.word === w.word.toUpperCase())) score += BAND_NAME_BONUS;
          if (canonical) {
            score += 20;
            name = canonical;
            keyMatch = keyMatch ?? canonical;
          }
          const prev = found.get(nk);
          if (!prev || prev.score < score) found.set(nk, { name, score });
        }
      }
      run = [];
      suffix = null;
    };
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      const w = nameWord(tok);
      if (!w) {
        flush();
        continue;
      }
      if (w.key in SUFFIXES && !w.initials) {
        if (run.length >= 2) suffix = SUFFIXES[w.key];
        flush();
        continue;
      }
      // "de" in lower case after a name word is part of the name, not the position DE.
      if (STOP_WORDS.has(w.key) && !(run.length > 0 && NAME_PARTICLES.has(w.word))) {
        flush();
        continue;
      }
      // A run longer than 3 words is likely a sentence; flush() drops it.
      run.push(w);
      // A comma ends a name unless a suffix follows ("Griffey, Jr.").
      if (/,$/.test(tok)) {
        const next = tokens[ti + 1];
        const nw = next ? nameWord(next) : null;
        if (!nw || !(nw.key in SUFFIXES)) flush();
      }
    }
    flush();
  }
  const names = [...found.values()].sort((a, b) => b.score - a.score).map((c) => c.name);
  return { names: names.slice(0, 5), keyMatch, hint, header, nameLines };
}

// ---------------------------------------------------------------------------
// Slabs and serial numbers

const GRADE_RE =
  /\b(GEM\s*-?\s*MI?N?T|PRISTINE|NM\s*-?\s*MT\+?|EX\s*-?\s*MT|VG\s*-?\s*EX|MINT|NM|EX|VG|GOOD|FAIR|POOR)\s*\+?\s*(10|[1-9](?:\.5)?)(?![\d.])/;

type SlabFind = { grader: string | null; grade: string | null; certNumber: string | null };

function findSlab(lines: Line[]): SlabFind | null {
  const all = lines.map((l) => l.up).join("\n");
  let grader: string | null = null;
  if (/\bPSA\s*\/?\s*DNA\b/.test(all)) grader = "PSA/DNA";
  else if (/\bPSA\b/.test(all)) grader = "PSA";
  else if (/\bBGS\b|\bBECKETT\s*GRADING\b/.test(all)) grader = "BGS";
  else if (/\bBECKETT/.test(all)) grader = "Beckett";
  else if (/\bSGC\b/.test(all)) grader = "SGC";
  else if (/\bCGC\b/.test(all)) grader = "CGC";
  let grade: string | null = null;
  const g = GRADE_RE.exec(all);
  if (g) grade = g[2];
  else if (grader) {
    const m = new RegExp(`\\b${grader}\\s*(10|[1-9](?:\\.5)?)(?![\\d.])`).exec(all);
    if (m) grade = m[1];
  }
  if (!grader && !grade) return null;
  let certNumber: string | null = null;
  for (const l of lines) {
    for (const t of l.tokens) {
      const s = t.replace(/^[#:]+/, "").replace(/[.,;:]+$/, "");
      if (/^\d{7,10}$/.test(s)) {
        certNumber = s;
        break;
      }
    }
    if (certNumber) break;
  }
  // A grade word without a grader or a cert number is too weak to call it a slab,
  // unless it sits on a label line with the card's year or number.
  if (!grader && !certNumber) {
    const labelLine = lines.some((l) => GRADE_RE.test(l.up) && (/\b(?:19|20)\d{2}\b/.test(l.up) || /#\s*\d/.test(l.up)));
    if (!labelLine) return null;
  }
  return { grader, grade, certNumber };
}

const LABEL_BRANDS: [RegExp, string][] = [
  [/^UPPER(?:\s*DECK)?$/, "Upper Deck"], [/^TOPPS$/, "Topps"], [/^FLEER$/, "Fleer"], [/^DONRUSS$/, "Donruss"],
  [/^BOWMAN$/, "Bowman"], [/^SCORE$/, "Score"], [/^SKYBOX$/, "SkyBox"], [/^HOOPS$/, "NBA Hoops"],
];

/** Holder labels print "1997 UPPER DECK ..." on one line; OCR often keeps only "1997 UPPER". */
function slabLabelYearBrand(lines: Line[]): { year: number; brand: string } | null {
  for (const l of lines) {
    // Copyright lines are read by findYear with their own rules (Leaf, Inc. and Donruss).
    if (isCopyrightLine(l)) continue;
    const m = /\b(19[5-9]\d|20[0-3]\d)\s+(UPPER(?:\s*DECK)?|TOPPS|FLEER|DONRUSS|BOWMAN|SCORE|SKYBOX|HOOPS)\b/.exec(l.up);
    if (!m) continue;
    const brand = LABEL_BRANDS.find(([re]) => re.test(m[2]))?.[1];
    if (brand) return { year: Number(m[1]), brand };
  }
  return null;
}

/** What the reader took for a serial number. Only ever a suggestion: the owner answers it. */
export type SerialRead = {
  /** "045/100", as read. */
  text: string;
  copy: string;
  edition: string;
  /** The line of text it stood in. */
  line: string;
  /** True when it is a weaker guess: no "Yes" button, only "Fix it" and "No". */
  weak: boolean;
  /** Plain reasons for a weak read. */
  why: string[];
};

/** Set sizes seen on checklist and set count lines. "1 of 792" is a set count, not a serial number. */
const KNOWN_SET_SIZES = new Set([100, 110, 132, 198, 200, 220, 264, 300, 330, 350, 396, 400, 440, 500, 528, 550, 600, 660, 700, 726, 792, 800, 825]);
const SERIAL_LOOK_ALIKE: Record<string, string> = { O: "0", o: "0", l: "1", I: "1", S: "5", B: "8" };
/** The card number line: "No. 45" or "#45" with one number only. */
const NUMBER_ONLY_LINE = /^\s*(?:NO\.?|#)\s*\d{1,4}\s*$/i;

/**
 * Looks for a print run mark like "045/100". Dropped, never guessed: a card
 * number line ("No. 45", "#45"), a read that equals the card number, a date
 * ("5/12/68"), a set count on a CARD or CHECKLIST line, a stat row, and a
 * line with BORN. A read is weak when a digit came from a look alike letter,
 * when the copy is above the edition, or when the card is from before 1990.
 */
export function findSerialRead(lines: Line[], opts: { cardNumber?: string | null; year?: number | null } = {}): SerialRead | null {
  const cardNumber = opts.cardNumber?.replace(/\s+/g, "") ?? null;
  for (const l of lines) {
    if (/\bBORN\b/.test(l.lz) || /\d+\/\d+\/\d+/.test(l.raw)) continue;
    if (NUMBER_ONLY_LINE.test(l.raw) || isStatRow(l)) continue;
    const re = /(^|[^\w/])([0-9OolISB]{1,4})\s*\/\s*([0-9OolISB]{2,4})(?![\w/])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.raw)) !== null) {
      if (!/\d/.test(m[2] + m[3])) continue;
      const alike = /[OolISB]/.test(m[2] + m[3]);
      const fix = (t: string) => t.replace(/[OolISB]/g, (c) => SERIAL_LOOK_ALIKE[c]);
      const copy = fix(m[2]);
      const edition = fix(m[3]);
      const a = Number(copy);
      const b = Number(edition);
      if (a < 1 || b < 10) continue;
      const text = `${copy}/${edition}`;
      if (cardNumber && cardNumber === text) continue;
      if (/\bCARDS?\b|\bCHECKLIST\b/.test(l.up) && (KNOWN_SET_SIZES.has(b) || /\bCHECKLIST\b/.test(l.up))) continue;
      const why: string[] = [];
      if (alike) why.push("a letter that looks like a digit was read as a digit");
      if (a > b) why.push("the copy number is higher than the print run");
      if (opts.year != null && opts.year < 1990) why.push("Cards before 1990 were almost never numbered");
      return { text, copy, edition, line: l.raw.trim().slice(0, 80), weak: why.length > 0, why };
    }
  }
  return null;
}

/** The card says ROOKIE or RC. Only a hint: it may be a Rated Rookie or an All-Star Rookie cup. */
function readsRookieWord(lines: Line[]): boolean {
  return lines.some((l) => /\bROOKIES?\b|\bRC\b/.test(l.up));
}

// ---------------------------------------------------------------------------
// Card

function emptyCard(): ParsedCard {
  return {
    year: null,
    brand: null,
    setName: null,
    cardNumber: null,
    playerCandidates: [],
    firstNameHint: null,
    team: null,
    teamHint: null,
    teamHintSport: null,
    sport: null,
    position: null,
    grader: null,
    grade: null,
    certNumber: null,
    serialNumber: null,
    serialRead: null,
    rookieWord: false,
    isAutograph: false,
    isReprint: false,
    evidence: [],
  };
}

/** Reads card details from the text of a card front and back (either may be missing). */
export function parseCardText(front: OcrResult | null, back: OcrResult | null): ParsedCard {
  try {
    return parseCardInner(toLines(front, "front"), toLines(back, "back"));
  } catch {
    return emptyCard();
  }
}

function parseCardInner(front: Line[], back: Line[]): ParsedCard {
  const out = emptyCard();
  const lines = [...back, ...front];
  if (lines.length === 0) return out;
  const ev = out.evidence;

  const hits = brandHits(lines);
  const slabLabel = slabLabelYearBrand(lines);
  const yearFind = findYear(lines, new Set(hits.map((h) => h.line)));
  out.year = yearFind?.year ?? slabLabel?.year ?? null;
  const pick = pickBrand(hits, out.year);
  out.brand = pick?.brand ?? slabLabel?.brand ?? null;
  if (!yearFind && slabLabel) ev.push(`Read ${slabLabel.year} ${slabLabel.brand} on the holder label`);

  if (yearFind?.how === "copyright") {
    ev.push(out.brand ? `Read copyright line: ${yearFind.year} ${out.brand}` : `Read copyright line: ${yearFind.year}`);
  } else if (yearFind?.how === "brand") {
    ev.push(`Read year ${yearFind.year} next to the brand name`);
  } else if (yearFind?.how === "stats") {
    ev.push(`Read stat table ending with ${yearFind.lastSeason}, so the card is likely from ${yearFind.year}`);
  }
  if (out.brand && yearFind?.how !== "copyright") ev.push(`Read brand: ${out.brand}`);
  if (!out.brand && hits.some((h) => h.def.key === "leafinc")) {
    ev.push("The copyright line says Leaf, Inc., which made both Donruss and Leaf cards. Check the logo on the front for the brand.");
  }

  out.cardNumber = findCardNumber(back, front);
  if (out.cardNumber) ev.push(`Read card number ${out.cardNumber}`);

  out.setName = findSetName(pick, lines, out.cardNumber);
  if (out.setName && out.setName !== out.brand) ev.push(`Read set: ${out.setName}`);

  const slab = findSlab([...front, ...back]);
  if (slab) {
    out.grader = slab.grader;
    out.grade = slab.grade;
    out.certNumber = slab.certNumber;
    const what = [slab.grader, slab.grade].filter(Boolean).join(" ");
    ev.push(`Read graded holder label${what ? `: ${what}` : ""}${slab.certNumber ? `, cert ${slab.certNumber}` : ""}`);
  }

  out.serialRead = findSerialRead(lines, { cardNumber: out.cardNumber, year: out.year });
  out.serialNumber = out.serialRead?.text ?? null;
  if (out.serialRead) ev.push(`Read ${out.serialRead.text}, maybe a serial number (the owner is asked)`);
  out.rookieWord = readsRookieWord(lines);

  const allUp = lines.map((l) => l.up).join(" ");
  // "AUT" is the short form on Beckett and PSA/DNA authentication labels.
  const labelAut = /\bAUT\b/.test(allUp) && /\bBECKETT|\bPSA\b|\bBAS\b|\bJSA\b/.test(allUp);
  if (labelAut || /\bAUTO(?:GRAPH(?:ED|S)?)?\b|\bSIGNATURES?\b|\bSIGNED\b|\bPSA\s*\/?\s*DNA\b|\bAUTHENTIC\s+AUTOGRAPH/.test(allUp)) {
    out.isAutograph = true;
    ev.push("Autograph wording read on the card or label");
  }
  if (/\bREPRINT\b/.test(allUp)) {
    out.isReprint = true;
    ev.push("The card says REPRINT: it is a later copy, not the original card");
  }

  // Sport clues other than the team, so they can settle a team name used in two sports.
  const votes: Votes = new Map();
  if (pick) vote(votes, pick.sport, pick.sportWeight);
  leagueAndStatVotes(lines, votes);
  const players = findPlayers(front, back);
  // The position in a name header ("Ken Griffey, Jr. * OF") beats one read elsewhere.
  const pos = players.header ?? findPosition([...front, ...back]);
  if (pos) {
    out.position = pos.position;
    vote(votes, pos.sport, 2);
    ev.push(`Read position: ${pos.position}`);
  }
  const { team, hint } = findTeam([...front, ...back], out.year, winner(votes), players.nameLines, pos);
  if (team) {
    out.team = team.team;
    if (team.ambiguous) ev.push(`Read team name ${team.team}, but it is used in more than one sport`);
    else {
      vote(votes, team.sport, 3);
      ev.push(`Read team: ${team.team}`);
    }
  } else if (hint) {
    out.teamHint = hint.team;
    out.teamHintSport = hint.sport;
    // A hint says half as much about the sport as a team read for sure.
    vote(votes, hint.sport, 3 * FUZZY_WEIGHT);
    ev.push(`Maybe team ${hint.team} (not sure, check it)`);
  }
  out.sport = winner(votes);

  out.playerCandidates = players.names;
  out.firstNameHint = players.hint;
  if (players.keyMatch) ev.push(`Name matches the key card list: ${players.keyMatch}`);

  return out;
}

// ---------------------------------------------------------------------------
// Products

function emptyProduct(): ParsedProduct {
  return {
    year: null,
    yearEnd: null,
    brand: null,
    setName: null,
    sport: null,
    productType: null,
    packCount: null,
    estCount: null,
    containerType: null,
    evidence: [],
  };
}

/** Reads product details from the text on a sealed box, pack, set or bulk box label. */
export function parseProductText(ocr: OcrResult): ParsedProduct {
  try {
    return parseProductInner(toLines(ocr, "front"));
  } catch {
    return emptyProduct();
  }
}

const RANGE_RE = /\b(19[5-9]\d|20[0-3]\d)\s*(?:-|TO|THRU|THROUGH)\s*(19[5-9]\d|20[0-3]\d|\d{2})\b/;

function parseProductInner(lines: Line[]): ParsedProduct {
  const out = emptyProduct();
  if (lines.length === 0) return out;
  const ev = out.evidence;
  const up = lines.map((l) => l.up).join("\n");
  const lz = lines.map((l) => l.lz).join("\n");

  // Years: a range first, then a year by the brand, then any plain year.
  const range = RANGE_RE.exec(up);
  if (range) {
    const a = Number(range[1]);
    const endRaw = range[2];
    if (endRaw.length === 4) {
      const b = Number(endRaw);
      if (b > a) {
        out.year = a;
        out.yearEnd = b;
        ev.push(`Read year range ${a} to ${b}`);
      } else if (b === a) out.year = a;
    } else if ((a + 1) % 100 === Number(endRaw)) {
      out.year = a;
      ev.push(`Read season ${a} to ${a + 1}`);
    }
  }
  const hits = brandHits(lines);
  if (out.year == null) {
    const y = findYear(lines, new Set(hits.map((h) => h.line)));
    let year = y && y.how !== "stats" ? y.year : null;
    if (year == null) {
      for (const l of lines) {
        for (const t of l.tokens) {
          year = plainYear(t);
          if (year != null) break;
        }
        if (year != null) break;
      }
    }
    if (year != null) {
      out.year = year;
      ev.push(`Read year ${year}`);
    }
  }

  const pick = pickBrand(hits, out.year);
  if (pick) {
    out.brand = pick.brand;
    out.setName = findSetName(pick, lines, null);
    ev.push(`Read brand: ${pick.brand}`);
  }

  // Sport words on the label.
  const sportWords: [RegExp, Sport][] = [
    [/\bBASEBALL\b/, "baseball"],
    [/\bBASKETBALL\b/, "basketball"],
    [/\bFOOTBALL\b/, "football"],
    [/\bHOCKEY\b/, "hockey"],
  ];
  const named = sportWords.filter(([re]) => re.test(lz)).map(([, s]) => s);
  if (/\bMULTI\s*-?\s*SPORTS?\b|\bMIXED\s*SPORTS?\b|\bALL\s*SPORTS\b/.test(lz) || named.length > 1) out.sport = "multi";
  else if (named.length === 1) out.sport = named[0];
  else {
    const votes: Votes = new Map();
    if (pick) vote(votes, pick.sport, pick.sportWeight);
    leagueAndStatVotes(lines, votes);
    out.sport = winner(votes);
  }

  // Bulk containers.
  const count = /\b(\d{2,6})\s*-?\s*(?:CT|COUNT)\b/.exec(up);
  let bulk: string | null = null;
  if (count) {
    out.estCount = Number(count[1]);
    bulk = `${count[1]} count box`;
  } else if (/\bMONSTER\s*BOX\b/.test(lz)) bulk = "Monster box";
  else if (/\bSHOE\s*BOX\b/.test(lz)) bulk = "Shoebox";
  else if (/\bBINDER\b/.test(lz)) bulk = "Binder";
  else if (/\bSTORAGE\s*BOX\b/.test(lz)) bulk = "Storage box";
  out.containerType = bulk;

  const packs = /\b(\d{1,4})\s*(?:WAX\s*|CELLO\s*|RACK\s*|FOIL\s*)?PACKS\b/.exec(up);
  if (packs) {
    const n = Number(packs[1]);
    if (n >= 1 && n <= 100_000) out.packCount = n;
  }
  if (out.estCount == null) {
    const cardsRe = /(^|[^A-Z])(\d{2,5})\s*(?:TRADING\s*)?CARDS\b(?!\s*(?:PER|EACH|IN\s*EACH|A\s*PACK))/g;
    let m: RegExpExecArray | null;
    while ((m = cardsRe.exec(up)) !== null) {
      const before = up.slice(Math.max(0, m.index - 6), m.index + m[1].length);
      const n = Number(m[2]);
      if (n >= 50 && !/PER\s*$/.test(before)) {
        out.estCount = n;
        break;
      }
    }
  }

  const sealedWords = /\bWAX\b|\bFACTORY\b|\bPACKS?\b|\bCELLO\b|\bRACK\b|\bBLISTER\b|\bCASE\b|\bSEALED\b/.test(lz);
  if (!bulk || sealedWords) {
    let type: ProductType | null = null;
    if (/\bFACTORY\s*(?:SEALED\s*)?SET\b|\bCOMPLETE\s*SET\b/.test(lz)) type = "factory_set";
    else if (/\bCASE\b/.test(lz)) type = "case";
    else if (/\bRACK\s*PACKS?\b/.test(lz)) type = "rack_pack";
    else if (/\bCELLO(?:PHANE)?\b/.test(lz)) type = "cello_pack";
    else if (/\bBLISTER\b/.test(lz)) type = "blister";
    else if (/\b(?:WAX|HOBBY|DISPLAY|RETAIL|FOIL)\s*BOX\b/.test(lz) || out.packCount != null) type = "box";
    else if (/\bWAX\s*PACK\b|\bFOIL\s*PACK\b|\bPACK\b/.test(lz)) type = "pack";
    else if (!bulk && /\bBOX\b/.test(lz)) type = "box";
    out.productType = type;
  }

  if (out.productType) ev.push(`Read product type: ${out.productType.replace(/_/g, " ")}`);
  if (out.packCount != null) ev.push(`Read ${out.packCount} packs`);
  if (out.containerType) ev.push(`Read container: ${out.containerType}`);
  else if (out.estCount != null) ev.push(`Read ${out.estCount} cards`);
  return out;
}

// ---------------------------------------------------------------------------
// Team hints and a player's team list

/**
 * The entry of `teams` (a player's teams from Wikidata, "Seattle Mariners")
 * that is the hinted team: same nickname, and the hint's sport is one of
 * the player's sports. Null when the list does not have it.
 */
export function teamFromList(hint: string, hintSport: Sport | null, sports: readonly Sport[], teams: readonly string[]): string | null {
  if (hintSport && sports.length > 0 && !sports.includes(hintSport)) return null;
  const key = normalizeName(hint);
  const exact = teams.find((t) => normalizeName(t) === key);
  if (exact) return exact;
  // The nickname at the end of the hint, longest first ("Red Sox", not "Sox").
  const group = [...NICK_GROUPS]
    .sort((a, b) => b.display.length - a.display.length)
    .find((g) => key === normalizeName(g.display) || key.endsWith(` ${normalizeName(g.display)}`));
  if (!group) return null;
  const nick = normalizeName(group.display);
  return teams.find((t) => {
    const n = normalizeName(t);
    return n === nick || n.endsWith(` ${nick}`);
  }) ?? null;
}
