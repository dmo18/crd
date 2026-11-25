import type { ProductType, Sport } from "@/db/schema";
import { GIVEN_NAMES } from "./given-names";
import { KEY_CARDS, normalizeName } from "./key-cards";
import type { OcrLine, OcrResult } from "./ocr";
import { CERTAIN_FIELDS, type CertainField } from "@/lib/recognition/types";

type Certainty = "sure" | "unsure";

/**
 * Turns noisy text read from a card, slab label or product box into card details.
 * No AI and no network: only patterns, word lists and the built-in key card list.
 * OCR mistakes are expected (O for 0, l or I for 1, S for 5, broken words), so
 * matching is forgiving where it is safe and strict where a wrong guess would hurt.
 * Nothing here throws: on any problem the fields stay empty.
 */

export type ParsedCard = {
  year: number | null;
  /** How many independent signs agree with the year (front set year, copyright, stat table). 0 without a year. */
  yearSigns: number;
  /** True when the year came only from the stat table's last season (the set of the year before is possible too). */
  yearFromStats: boolean;
  /** How many independent places name the brand: the front logo, a back logo, the copyright line (0 to 3). */
  brandSigns: number;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  /** The player as read (front first, see choosePlayer), or null. */
  player: string | null;
  /** True when the front and the back agree on the player's name. */
  playerAgree: boolean;
  /** The player as written on each side that agrees, the chosen form first; at most 5. Empty with no player. */
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
  /** Per filled field: "sure" when two independent signs on the card agree, else "unsure". */
  certainty: Partial<Record<CertainField, Certainty>>;
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
  /** Read the same in two reads of its spot (see OcrLine.twice). */
  twice: boolean;
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
    // A bullet between words is a word of its own ("ORIOLES\u2022PITCHER",
    // "Griffey,Jr.\u2022OF"), and so is the word after a comma ("Griffey,Jr.").
    .replace(/\s*[\u2022\u00b7\u25cf]\s*/g, " \u2022 ")
    .replace(/,(?=[A-Za-z])/g, ", ")
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

function makeLine(text: string, conf: number, box: LineBox, side: Side, source: Line["source"] = "page", twice = false): Line | null {
  const raw = cleanRaw(text);
  if (!raw) return null;
  const up = upper(raw);
  return { raw, up, lz: letterize(up), tokens: raw.split(" "), conf, box, side, source, twice };
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
      const line = makeLine(l.text, num(l.confidence, 0.5), box, side, lineSource(l.source), l.twice === true);
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
  for (const [i, c] of [...s].entries()) {
    if (c >= "0" && c <= "9") out += c;
    // Years here start 19 or 20: an S second after a 1 is a blurred 9 ("1S8S" is 1985).
    else if (i === 1 && /[Ss]/.test(c) && out === "1") out += "9";
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

type YearFind = {
  year: number; how: "copyright" | "brand" | "stats"; score: number; line?: Line; lastSeason?: number;
  /** The table counts seasons over two years ("97-98"): basketball and hockey. lastSeason is the first of the two. */
  twoYear?: boolean;
};

/** The season a stat table row starts with ("87", "1987", "'87", "84-85"), or null. */
function rowSeason(first: string): number | null {
  const t = first.replace(/^'/, "");
  let m = /^(?:19)?([5-9]\d)$/.exec(t);
  if (m) return 1900 + Number(m[1]);
  m = /^(?:19)?([5-9]\d)-(?:19)?(\d{2})$/.exec(t);
  if (m && (Number(m[1]) + 1) % 100 === Number(m[2])) return 1900 + Number(m[1]);
  // "2017-18", "99-00", "00-01", "2000-01": a season over two years, 2000s too.
  m = /^(?:19|20)?(\d{2})-(?:19|20)?(\d{2})$/.exec(t);
  if (m && (Number(m[1]) + 1) % 100 === Number(m[2])) return twoDigit(Number(m[1]));
  return null;
}

/** "97-98", "1997-98", "2017-18": the season token runs over two years. */
function twoYearSeason(first: string): boolean {
  return /^'?(?:19|20)?\d{2}-(?:19|20)?\d{2}$/.test(first);
}

/** A totals row of a stat table: "TOTALS", "11-YEAR TOTALS", "CAREER", "2 NBA TOTALS", "11 NHL SEASONS". */
function totalsRow(l: Line): boolean {
  return /\bTOTALS?\b|\bCAREER\b|\b(?:NBA|NHL|NFL|MLB|ML|MAJ|MAJOR\s*LEAGUE)\s*(?:TOTALS?|SEASONS?)\b/.test(l.lz.replace(/\d+-YEAR/g, ""));
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
  // Club words in capitals, or capitalized ("1991 Orioles 4.01 31") when numbers follow.
  while (k < rest.length && k < 3 && /^[A-Z][A-Za-z.'-]*$/.test(rest[k])) {
    letters += rest[k].replace(/[^A-Za-z]/g, "").length;
    k++;
  }
  if (k === 0 || letters < 3 || rest[0].replace(/[^A-Z]/g, "") in POS_TOKENS) return false;
  const after = rest.slice(k);
  if (after.length === 0) return rest.every((w) => w === w.toUpperCase()) && clubOnly(rest);
  return after.length >= 2 || rest.slice(0, k).every((w) => w === w.toUpperCase()) ? after.every(isNumber) : false;
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
  const rows: { season: number; y: number; h: number; i: number; twoYear: boolean }[] = [];
  lines.forEach((l, i) => {
    if (l.tokens.length < 2) return;
    const season = rowSeason(l.tokens[0]);
    if (season != null && isStatRow(l)) rows.push({ season, y: l.box.y, h: l.box.h, i, twoYear: twoYearSeason(l.tokens[0]) });
  });
  rows.sort((a, b) => a.y - b.y || a.i - b.i);
  if (rows.length === 0) return null;
  const lastRow = rows[rows.length - 1];
  const last = lastRow.season;
  const twoYear = lastRow.twoYear;
  // Single year seasons are trusted up to 1995 (later sets print many
  // tables of other kinds); seasons over two years are plain to see.
  if (last < 1950 || last > (twoYear ? 2030 : 1995)) return null;
  if (rows.length < 2 || new Set(rows.map((r) => r.season)).size < 2) {
    // One season row with the totals row right under it: a career table of
    // one season so far, or a "best year" table. The row is the last season.
    const below = lines.some((l) => totalsRow(l) && l.box.y > lastRow.y && l.box.y - lastRow.y < 2.5 * Math.max(lastRow.h, l.box.h));
    if (rows.length !== 1 || !below) return null;
    return { year: last + 1, how: "stats", score: 2, lastSeason: last, twoYear };
  }
  // In order: one season apart, the same season (two clubs in one year), or
  // two apart (a season not played, or a row the reader lost).
  const step = last - rows[rows.length - 2].season;
  if (step < 0 || step > 2) return null;
  // A stat row right under the last one whose season the reader got wrong
  // ("1884" for 1984): a row of the table all the same, so the table runs one
  // season further. Only for one year seasons, one row step below, in the
  // same column.
  if (!twoYear && misreadRowBelow(lines, lines[lastRow.i], rows)) {
    return { year: last + 2, how: "stats", score: 2, lastSeason: last + 1, twoYear };
  }
  return { year: last + 1, how: "stats", score: 2, lastSeason: last, twoYear };
}

/**
 * A stat row just below the table's last row whose first token has four
 * digits but is no season ("1884"): the next row of the table, misread.
 */
function misreadRowBelow(lines: Line[], lastLine: Line, rows: { y: number }[]): boolean {
  const gaps = rows.slice(1).map((r, k) => r.y - rows[k].y).filter((g) => g > 0);
  const usual = middle(gaps);
  if (!(usual > 0)) return false;
  return lines.some((l) => {
    if (l === lastLine || l.tokens.length < 2 || !/^\d{4}$/.test(l.tokens[0]) || rowSeason(l.tokens[0]) != null) return false;
    const dy = l.box.y - lastLine.box.y;
    if (dy < 0.5 * usual || dy > 1.5 * usual) return false;
    if (Math.abs(l.box.x - lastLine.box.x) > Math.max(lastLine.box.h, l.box.h)) return false;
    return isStatRow(l);
  });
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

/**
 * Table rows the reader cut into cells ("1991", "Orioles", "4.01", "31"):
 * cells of one side on one line, joined left to right into one line, so a
 * stat row reads as a row again. Only short cells (one or two words) are
 * joined, so a column of running text beside the table stays out.
 */
function tableRows(lines: Line[]): Line[] {
  // A cell much taller than the usual cell (several numbers read as one
  // tall box) would join two rows into one: left out.
  const short = lines.filter((l) => l.tokens.length <= 2 && l.box.h > 0);
  const usual = middle(short.map((l) => l.box.h));
  const cells = short.filter((l) => l.box.h <= 2 * usual);
  const used = new Set<Line>();
  const out: Line[] = [];
  const sorted = [...cells].sort((a, b) => a.box.y - b.box.y);
  for (const c of sorted) {
    if (used.has(c)) continue;
    const mid = c.box.y + c.box.h / 2;
    const row = cells.filter((o) => !used.has(o) && Math.abs(o.box.y + o.box.h / 2 - mid) < Math.min(o.box.h, c.box.h) * 0.5);
    if (row.length < 3) continue;
    for (const o of row) used.add(o);
    row.sort((a, b) => a.box.x - b.box.x);
    const box = { x: row[0].box.x, y: Math.min(...row.map((o) => o.box.y)), w: 0, h: Math.max(...row.map((o) => o.box.h)) };
    box.w = Math.max(...row.map((o) => o.box.x + o.box.w)) - box.x;
    const line = makeLine(row.map((o) => o.raw).join(" "), Math.min(...row.map((o) => o.conf)), box, c.side, c.source);
    if (line) out.push(line);
  }
  return out;
}

/** Lines whose middles sit at the same height: one printed row ("DONRUSS" and "1992" read as two boxes). */
function sameRow(a: Line, b: Line): boolean {
  return Math.abs(a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2)) < Math.min(a.box.h, b.box.h) * 0.6;
}

/**
 * "'93-94", "93-94", "2003-04", "2003-2004" (a season over two years) or
 * "'87": the first year, or null. Season sports name a set by the season's
 * first year.
 */
function seasonYear(t: string): number | null {
  const s = stripEnds(t.replace(/^'/, "x")).replace(/^x/, "'");
  let m = /^'?(\d{2})-(\d{2})$/.exec(s);
  if (m && (Number(m[1]) + 1) % 100 === Number(m[2])) return twoDigit(Number(m[1]));
  m = /^((?:19|20)\d{2})-((?:19|20)?\d{2})$/.exec(s);
  if (m && (Number(m[1]) + 1) % (m[2].length === 4 ? 10000 : 100) === Number(m[2])) return validYear(Number(m[1]));
  m = /^'(\d{2})$/.exec(s);
  if (m) return twoDigit(Number(m[1]));
  return null;
}

function twoDigit(n: number): number | null {
  if (n >= 50) return 1900 + n;
  return n <= 30 ? 2000 + n : null;
}

/** A line that holds a copyright notice: the mark, the word, or a company word with a maker named. */
function copyrightNotice(l: Line, branded: boolean): boolean {
  if (l.raw.includes("\u00a9") || /COPYRIGHT|\bCOPR\b/.test(l.lz)) return true;
  return branded && /\bINC\b|\bCORP\b|\bLTD\b|\bCOMPANY\b|\bCO\b|\bMARKETING\b/.test(l.lz);
}

/** Gap between two boxes on each axis (0 when they overlap on it). */
function boxGap(a: LineBox, b: LineBox): { dx: number; dy: number } {
  return {
    dx: Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    dy: Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  };
}

/**
 * A short year printed large in a logo on the back ("TOP PROSPECT '91"): a
 * line of only two digits (an apostrophe may be lost), at least 1.5 times
 * the usual text height, touching a logo word of 3 or more letters. Jersey
 * numbers in a back photo stand alone, card numbers sit in corners.
 */
function logoShortYear(back: Line[]): number | null {
  const usual = middle(back.filter((l) => l.raw.replace(/[^A-Za-z0-9]/g, "").length >= 3).map((l) => l.box.h));
  if (!(usual > 0)) return null;
  for (const l of back) {
    if (l.tokens.length !== 1) continue;
    const m = /^'?(\d{2})$/.exec(stripEnds(l.tokens[0].replace(/^'/, "x")).replace(/^x/, "'"));
    if (!m || l.box.h < 1.5 * usual) continue;
    const b = l.box;
    if ((b.x < CORNER_X || b.x + b.w > 1 - CORNER_X) && (b.y < CORNER_Y || b.y + b.h > 1 - CORNER_Y)) continue;
    const touching = back.some((o) => {
      if (o === l || isSentence(o) || isCopyrightLine(o) || (o.lz.match(/[A-Z]/g) ?? []).length < 3) return false;
      const g = boxGap(b, o.box);
      return g.dx <= 0.6 * b.h && g.dy <= 0.6 * b.h;
    });
    if (touching) return twoDigit(Number(m[1]));
  }
  return null;
}

type CardYear = {
  year: number;
  how: "front" | "copyright" | "stats" | "brand";
  /** The copyright year read, when one was. */
  copyright?: number;
  lastSeason?: number;
  /** The year came from a short year in a logo on the back ("'91"). */
  logoYear?: boolean;
  /** Independent signs that agree with the year (1 to 3). */
  signs: number;
};

/**
 * The card's year, card first (12R.4):
 * 1. a set year printed with the maker's name on the front ("DONRUSS 1992",
 *    "'93-94 FLEER" means 1993) wins;
 * 2. else the copyright year on the back. With two copyright years ("1988
 *    USOC", "1991 Impel Marketing") the one on the maker's line, else the
 *    latest. When the stat table's last season is that same year, the card
 *    is of the next year (stats through 1991 and copyright 1991: a 1992 set);
 *    a last season after the copyright year cannot be settled: no year;
 * 3. else the last stat season plus one, else a year on a line with the maker's name.
 */
function findCardYear(front: Line[], back: Line[], all: Line[], brandLines: Set<Line>, seen: { conflict: boolean } = { conflict: false }): CardYear | null {
  // 1. The front: a row with a maker's name and a year.
  let frontYear: number | null = null;
  let frontSeason = false;
  for (const l of front) {
    if (!brandLines.has(l) || isCopyrightLine(l)) continue;
    for (const o of front.filter((x) => x === l || sameRow(x, l))) {
      for (const t of o.tokens) {
        const plain = o === l || o.tokens.length <= 2 ? fixedYear(t) : null;
        const y = plain ?? seasonYear(t);
        if (y != null && validYear(y)) {
          frontYear = y;
          frontSeason = plain == null && /\d-\d/.test(t);
          break;
        }
      }
      if (frontYear != null) break;
    }
    if (frontYear != null) break;
  }

  // 2. Copyright years, the maker's line first.
  const notices: { year: number; maker: boolean }[] = [];
  for (const l of all) {
    const maker = brandLines.has(l);
    if (!copyrightNotice(l, maker)) continue;
    for (const t of l.tokens) {
      const y = fixedYear(t) ?? fixedYear(t.replace(/^(?:COPR|\u00a9)\.?/i, ""));
      if (y != null) notices.push({ year: y, maker });
    }
  }
  const makerYears = notices.filter((n) => n.maker).map((n) => n.year);
  const pool = makerYears.length > 0 ? makerYears : notices.map((n) => n.year);
  const copyright = pool.length > 0 ? Math.max(...pool) : null;

  const stats = yearFromStats([...back, ...tableRows(back), ...front, ...tableRows(front)]);
  const last = stats?.lastSeason ?? null;

  if (frontYear != null) {
    // Signs that cannot fit the front's year leave the year blank: a card is
    // copyrighted in its year or the year before (season sets: the season's
    // second year too), and its stat table never runs past its year.
    const season = frontSeason;
    if ((copyright != null && (copyright < frontYear - 1 || copyright > frontYear + (season ? 1 : 0))) || (last != null && last > frontYear)) {
      seen.conflict = true;
      return null;
    }
    let signs = 1;
    if (copyright != null && copyright >= frontYear - 1) signs++;
    if (last != null && (last === frontYear - 1 || (season && last === frontYear))) signs++;
    return { year: frontYear, how: "front", copyright: copyright ?? undefined, lastSeason: last ?? undefined, signs };
  }
  // A large short year in a logo on the back ("TOP PROSPECT '91") one year
  // after the copyright: sets are made the year before they are named for.
  // One sign only (12R.5 round 2): a logo year is easy to take from a jersey
  // or a picture, so the year is filled but not sure.
  if (copyright != null && logoShortYear(back) === copyright + 1) {
    return { year: copyright + 1, how: "copyright", copyright, lastSeason: last ?? undefined, signs: 1, logoYear: true };
  }
  if (copyright != null && stats?.twoYear && last != null && (copyright === last + 1 || copyright === last + 2)) {
    // Basketball and hockey: the set is named by the season's first year
    // ("1998-99"), while the copyright often shows the second (\u00a91999).
    // After a last row of 97-98 the card is of 1998-99: 1998.
    return { year: last + 1, how: "copyright", copyright, lastSeason: last, signs: 2 };
  }
  if (copyright != null) {
    if (last == null) return { year: copyright, how: "copyright", copyright, signs: 1 };
    if (last > copyright) {
      seen.conflict = true;
      return null;
    }
    if (last === copyright) return { year: copyright + 1, how: "copyright", copyright, lastSeason: last, signs: 2 };
    return { year: copyright, how: "copyright", copyright, lastSeason: last, signs: last === copyright - 1 ? 2 : 1 };
  }
  if (stats) return { year: stats.year, how: "stats", lastSeason: last ?? undefined, signs: 1 };
  // A year on a line with the maker's name, anywhere ("1989 UPPER DECK").
  for (const l of all) {
    if (!brandLines.has(l)) continue;
    for (const t of l.tokens) {
      const y = fixedYear(t) ?? seasonYear(t);
      if (y != null) return { year: y, how: "brand", signs: 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Brands

type BrandDef = {
  key: string;
  /** The maker. For a product, the company that makes it ("Prizm": Panini). */
  brand: string;
  /** The product (set) the words name, when they name one. */
  set?: string;
  /**
   * The modern era of a name (12R.5 round 2): from this year on, Donruss,
   * Score and the like are products of `brand` (Panini) with this set name;
   * before it they are makers themselves (`brand` above, no set), or with
   * `setOnly` the words name only a set ("Select" was a Score set too).
   */
  modern?: { from: number; brand: string; set: string; setOnly?: boolean };
  re: RegExp;
  copyrightOnly?: boolean;
  /** A plain word that counts only as logo text: a short line of its own. */
  logoOnly?: boolean;
  /** A clue that loses to any other brand read on the card. */
  weak?: boolean;
  sport?: Sport;
  sportWeight?: number;
};

/**
 * Makers and their products, one table for brand and set (12R.5 round 2).
 * A product's words give its maker as the brand and the product as the set
 * ("PRIZM": Panini, Prizm; "BLACK DIAMOND": Upper Deck, Black Diamond).
 * Names that changed hands carry their modern era (Donruss and Score are
 * Panini products from 2010 on). A one word product that is also a plain
 * word counts only as logo text.
 */
const BRANDS: BrandDef[] = [
  { key: "udminor", brand: "Upper Deck", set: "Upper Deck Minor League", re: /\bUPPER\s*DECK\s*MINOR\s*LEAGUE\b/g, sport: "baseball", sportWeight: 2 },
  { key: "spauth", brand: "Upper Deck", set: "SP Authentic", re: /\bSP\s*AUTHENTIC\b/g },
  { key: "spx", brand: "Upper Deck", set: "SPx", re: /\bSPX\b/g, logoOnly: true },
  { key: "sp", brand: "Upper Deck", set: "SP", re: /\bUPPER\s*DECK\s*SP\b|^SP$/g },
  { key: "blackdiamond", brand: "Upper Deck", set: "Black Diamond", re: /\bBLACK\s*DIAMOND\b/g },
  { key: "younguns", brand: "Upper Deck", set: "Young Guns", re: /\bYOUNG\s*GUNS\b/g, logoOnly: true },
  { key: "udice", brand: "Upper Deck", set: "Ice", re: /^(?:UPPER\s*DECK\s*)?ICE$/g, logoOnly: true },
  { key: "stadiumclub", brand: "Topps", set: "Stadium Club", re: /\bSTADIUM\s*CLUB\b/g },
  { key: "bowmanchrome", brand: "Topps", set: "Bowman Chrome", re: /\bBOWMAN\s*CHROME\b/g },
  { key: "heritage", brand: "Topps", set: "Heritage", re: /\bTOPPS\s*HERITAGE\b|^HERITAGE$/g, logoOnly: true },
  { key: "ginter", brand: "Topps", set: "Allen & Ginter", re: /\bALLEN\s*(?:&|AND)\s*GINTER\b/g },
  { key: "ultra", brand: "Fleer", set: "Fleer Ultra", re: /\bULTRA\b/g },
  { key: "flair", brand: "Fleer", set: "Flair", re: /\bFLAIR\b/g, logoOnly: true },
  { key: "finest", brand: "Topps", set: "Finest", re: /\bFINEST\b/g, logoOnly: true },
  { key: "chrome", brand: "Topps", set: "Topps Chrome", re: /\bTOPPS\s*CHROME\b/g },
  { key: "collchoice", brand: "Upper Deck", set: "Collector's Choice", re: /\bCOLLECTOR'?S\s*CHOICE\b/g },
  { key: "prizm", brand: "Panini", set: "Prizm", re: /\bPRIZM\b/g },
  { key: "optic", brand: "Panini", set: "Optic", re: /\bOPTIC\b/g, logoOnly: true },
  { key: "mosaic", brand: "Panini", set: "Mosaic", re: /\bMOSAIC\b/g, logoOnly: true },
  { key: "chronicles", brand: "Panini", set: "Chronicles", re: /\bCHRONICLES\b/g, logoOnly: true },
  { key: "contenders", brand: "Playoff", set: "Contenders", re: /\bCONTENDERS\b/g, logoOnly: true, modern: { from: 2010, brand: "Panini", set: "Contenders" } },
  { key: "absolute", brand: "Playoff", set: "Absolute", re: /\bABSOLUTE\b/g, logoOnly: true, modern: { from: 2010, brand: "Panini", set: "Absolute" } },
  { key: "certified", brand: "Panini", set: "Certified", re: /^CERTIFIED$/g, logoOnly: true, modern: { from: 2010, brand: "Panini", set: "Certified", setOnly: true } },
  { key: "select", brand: "Panini", set: "Select", re: /^SELECT$/g, logoOnly: true, modern: { from: 2010, brand: "Panini", set: "Select", setOnly: true } },
  { key: "panini", brand: "Panini", re: /\bPANINI\b/g },
  // "Score Board, Inc." made memorabilia cards; it is not the Score brand.
  { key: "scoreboard", brand: "Score Board", re: /\bSCORE\s*BOARD\b(?=\s*,?\s*INC)/g, copyrightOnly: true },
  { key: "topps", brand: "Topps", re: /\bTOPPS\b/g },
  { key: "upperdeck", brand: "Upper Deck", re: /\bUPPER\s*DECK\b/g },
  // "\u00a92022 UDC." and "The Cippe Deck Co" (UPPER misread): only The Upper Deck Company
  // signs its copyright line as UDC or as a "Deck Co".
  { key: "udc", brand: "Upper Deck", re: /\bUDC\b|(?<!UPPER\s*)\bDECK\s*(?:CO|COMPANY)\b/g, copyrightOnly: true },
  { key: "artifacts", brand: "Upper Deck", set: "Artifacts", re: /\bARTIFACTS\b/g, logoOnly: true },
  // "F1EER" is a common misread; the 1 becomes I in the letter version of the line.
  { key: "fleer", brand: "Fleer", re: /\bF[LI]EER\b/g },
  // Donruss and Score made cards of several sports: the name is no sign of one.
  { key: "donruss", brand: "Donruss", re: /\bDONRUS{1,2}\b/g, modern: { from: 2010, brand: "Panini", set: "Donruss" } },
  { key: "score", brand: "Score", re: /\bSCORE\b(?!\s*BOARD)/g, modern: { from: 2010, brand: "Panini", set: "Score" } },
  { key: "sportflics", brand: "Sportflics", re: /\bSPORTFLICS\b/g, sport: "baseball", sportWeight: 1 },
  // Score cards were made by Major League Marketing, named in the copyright line.
  { key: "mlm", brand: "Score", re: /\bMAJOR\s*LEAGUE\s*MARKETING\b/g },
  { key: "bowman", brand: "Bowman", re: /\bBOWMAN\b/g },
  { key: "opc", brand: "O-Pee-Chee", re: /\bO\s*-?\s*PEE\s*-?\s*CHEE\b|\bOPC\b/g },
  { key: "leafinc", brand: "Leaf", re: /\bLEAF\s*,?\s*INC\b/g },
  { key: "leaf", brand: "Leaf", re: /\bLEAF\b(?!\s*,?\s*INC)/g },
  { key: "proset", brand: "Pro Set", re: /\bPRO\s*SET\b/g },
  { key: "hoops", brand: "NBA Hoops", re: /\bHOOPS\b/g, sport: "basketball", sportWeight: 2 },
  // League and players' union names ("NBA Properties", "MLBPA", "NHLPA") are
  // licence text that every maker prints: never a brand (12R.5).
  { key: "skybox", brand: "SkyBox", re: /\bSKY\s*BOX\b/g },
  { key: "pinnacle", brand: "Pinnacle", re: /\bPINNACLE\b/g },
  { key: "classic", brand: "Classic", re: /\bCLASSIC\b/g, copyrightOnly: true },
  { key: "star", brand: "Star", re: /\bSTAR\s*CO\b|\bSTAR\s*COMPANY\b/g },
  { key: "starc", brand: "Star", re: /\bSTAR\b(?!\s*PICS)/g, copyrightOnly: true },
  { key: "pacific", brand: "Pacific", re: /\bPACIFIC\s*TRADING\b/g },
  { key: "pacificc", brand: "Pacific", re: /\bPACIFIC\b/g, copyrightOnly: true },
  { key: "actionpacked", brand: "Action Packed", re: /\bACTION\s*PACKED\b/g },
  { key: "procards", brand: "Pro Cards", re: /\bPRO\s*CARDS\b/g, sport: "baseball", sportWeight: 2 },
  { key: "kelloggs", brand: "Kellogg's", re: /\bKELLOGG'?S?\b/g },
  { key: "drakes", brand: "Drake's", re: /\bDRAKE'?S\b/g, sport: "baseball", sportWeight: 1 },
  { key: "parkhurst", brand: "Parkhurst", re: /\bPARKHURST\b/g, sport: "hockey", sportWeight: 2 },
  { key: "itg", brand: "In The Game", re: /\bIN\s*THE\s*GAME\b/g, copyrightOnly: true, sport: "hockey", sportWeight: 1 },
  // Impel Marketing made the U.S. Olympic and early SkyBox era sets.
  { key: "impel", brand: "Impel", re: /\bIMPEL\b/g },
  { key: "playoff", brand: "Playoff", re: /\bPLAYOFF\s*(?:CORP|INC)\b/g, copyrightOnly: true },
  { key: "wildcard", brand: "Wild Card", re: /\bWILD\s*CARD\b/g, copyrightOnly: true },
  { key: "presspass", brand: "Press Pass", re: /\bPRESS\s*PASS\b/g },
  { key: "frontrow", brand: "Front Row", re: /\bFRONT\s*ROW\b/g, copyrightOnly: true },
  { key: "starpics", brand: "Star Pics", re: /\bSTAR\s*PICS\b/g },
  { key: "tristar", brand: "Tristar", re: /\bTRI\s*-?\s*STAR\b/g },
];

/**
 * Set names read as logo text that do not say the maker by themselves
 * ("SELECT" was a Score set in the 1990s and a Panini set later). Counted
 * only on a short line of its own, never in running text.
 */
const SET_LOGOS: [RegExp, string][] = [[/^SELECT$/, "Select"], [/^CERTIFIED$/, "Certified"], [/^METAL(?:\s*UNIVERSE)?$/, "Metal"]];

/**
 * Every product (set) name of the maker and product table, and the set logos:
 * a read set name on this list names the product the catalog files the card
 * under ("Prizm", "Stadium Club"), not an insert or subset.
 */
export const PRODUCT_NAMES: readonly string[] = [
  ...new Set([...BRANDS.flatMap((d) => [d.set, d.modern?.set]), ...SET_LOGOS.map(([, name]) => name)].filter((v): v is string => Boolean(v))),
];

const productKey = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A product name as a catalog writes it ("Prizm", "Panini Prizm", "Stadium
 * Club", "Ultra") through the maker and product table: its maker as the brand
 * and the product as the set, in the card's year. Null when the words are
 * not a product of a known maker (a plain maker such as "Topps", or an
 * unknown word); a name that is only a set ("Select" before 2010) is null too.
 */
export function productMaker(words: string | null | undefined, year: number | null): { brand: string; set: string } | null {
  const k = productKey(String(words ?? ""));
  if (!k) return null;
  for (const def of BRANDS) {
    const names = hitNames(def, year);
    if (!names.set || !names.brand) continue;
    const forms = [def.key, names.set, `${names.brand} ${names.set}`].map(productKey);
    if (forms.includes(k) && productKey(names.brand) !== k) return { brand: names.brand, set: names.set };
  }
  return null;
}

/**
 * Makers that are one company, or owned one another, in the years cards
 * carry both names (Leaf, Inc. owned Donruss; Pinnacle Brands made Score
 * and later Donruss; Panini bought Donruss Playoff; Fleer and SkyBox merged;
 * Bowman is Topps). Two such names on one card agree; names of two
 * different families contradict each other.
 */
const MAKER_FAMILIES: string[][] = [
  ["Topps", "Bowman", "O-Pee-Chee"],
  ["Upper Deck", "O-Pee-Chee"],
  ["Fleer", "SkyBox", "NBA Hoops", "Impel"],
  ["Donruss", "Leaf", "Playoff", "Panini", "Score", "Pinnacle", "Sportflics", "Action Packed"],
];

function sameMaker(a: string, b: string): boolean {
  return a === b || MAKER_FAMILIES.some((f) => f.includes(a) && f.includes(b));
}

/** What a hit names in the card's year: its maker (null: only a set) and its set. */
function hitNames(def: BrandDef, year: number | null): { brand: string | null; set: string | null } {
  const m = def.modern;
  if (m && year != null && year >= m.from) return { brand: m.brand, set: m.set };
  if (m?.setOnly) return { brand: null, set: m.set };
  return { brand: def.brand, set: def.set ?? null };
}

/** `logo`: read on a short line of its own, not a copyright line: the maker's logo text. */
type BrandHit = { def: BrandDef; line: Line; score: number; logo: boolean };

/**
 * Logo words printed one above the other ("UPPER" over "DECK"), read as two
 * boxes: one word each, letters only, about the same size, the second right
 * under the first and starting at the same place. Joined into one line so a
 * maker's two word name is found (12R.5).
 */
export function stackedLogoLines(lines: Line[]): Line[] {
  const words = lines.filter((l) => l.tokens.length === 1 && /^[A-Z][A-Z\u2022.]{1,}$/.test(l.lz.replace(/[^A-Z\u2022.]/g, "")) && l.box.h > 0);
  const out: Line[] = [];
  for (const a of words) {
    for (const b of words) {
      if (a === b || a.side !== b.side) continue;
      const gap = b.box.y - (a.box.y + a.box.h);
      const h = Math.max(a.box.h, b.box.h);
      const sameSize = h < 1.6 * Math.min(a.box.h, b.box.h);
      const overlapX = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      const below = b.box.y > a.box.y && gap < 0.6 * h;
      if (!sameSize || !below || overlapX < 0.6 * Math.min(a.box.w, b.box.w) || Math.abs(a.box.x - b.box.x) > 2 * h) continue;
      const text = `${a.raw} ${b.raw}`.replace(/(?<=\p{L})[\u2022.](?=\p{L})/gu, "");
      const box = { x: Math.min(a.box.x, b.box.x), y: a.box.y, w: Math.max(a.box.w, b.box.w), h: b.box.y + b.box.h - a.box.y };
      const line = makeLine(text, Math.min(a.conf, b.conf), box, a.side, a.source);
      if (line) out.push(line);
    }
  }
  return out;
}

function brandHits(lines: Line[]): BrandHit[] {
  const hits: BrandHit[] = [];
  const stacked = stackedLogoLines(lines);
  for (const l of [...lines, ...stacked]) {
    const isStack = stacked.includes(l);
    const copyright = isCopyrightLine(l);
    const short = l.tokens.length <= 3;
    const logo = short && !copyright && !isSentence(l);
    const hasYear = l.tokens.some((t) => fixedYear(t) != null);
    for (const def of BRANDS) {
      if (def.copyrightOnly && !copyright) continue;
      if (def.logoOnly && !logo) continue;
      // Two stacked words count only for a name they make together.
      if (isStack && l.tokens.some((t) => letterize(upper(t)).match(def.re))) continue;
      def.re.lastIndex = 0;
      const count = l.lz.match(def.re)?.length ?? 0;
      for (let i = 0; i < count; i++) {
        const score = def.weak ? 0.5 : 1 + (copyright ? 3 : 0) + (short ? 2 : 0) + (hasYear ? 1 : 0) + (l.side === "back" ? 0.5 : 0);
        hits.push({ def, line: l, score, logo: logo && !def.copyrightOnly });
      }
    }
    if (isStack) continue;
    // A copyright line read with its spaces lost ("\u00a91990 THETOPPS"): the maker's name inside the letters.
    if (copyright && !hits.some((h) => h.line === l)) {
      const compact = l.lz.replace(/[^A-Z]/g, "");
      const glued = GLUED_MAKERS.find((g) => compact.includes(g.word));
      const def = glued && BRANDS.find((b) => b.key === glued.key);
      if (def) hits.push({ def, line: l, score: 4 + (hasYear ? 1 : 0), logo: false });
    }
    // A logo word with one letter misread ("JONRUSS"): a weak clue, never a logo that beats the copyright.
    if (l.tokens.length <= 2 && !copyright && !hits.some((h) => h.line === l)) {
      for (const word of l.lz.split(/[^A-Z]+/)) {
        if (word.length < 6) continue;
        const def = FUZZY_LOGOS.find((d) => d.word.length === word.length && editDistance(d.word, word) === 1);
        const brand = def && BRANDS.find((b) => b.key === def.key);
        if (brand) hits.push({ def: brand, line: l, score: 1, logo: false });
      }
    }
  }
  return hits;
}

/** Maker names as they stand in a copyright line read without spaces. */
const GLUED_MAKERS: { word: string; key: string }[] = [
  { word: "TOPPS", key: "topps" }, { word: "FLEER", key: "fleer" }, { word: "DONRUSS", key: "donruss" },
  { word: "UPPERDECK", key: "upperdeck" }, { word: "BOWMAN", key: "bowman" }, { word: "LEAFINC", key: "leafinc" },
  { word: "SKYBOX", key: "skybox" }, { word: "PINNACLEBRANDS", key: "pinnacle" }, { word: "PACIFICTRADING", key: "pacific" },
  { word: "PROSET", key: "proset" }, { word: "OPEECHEE", key: "opc" }, { word: "IMPELMARKETING", key: "impel" },
  { word: "PANINI", key: "panini" }, { word: "PLAYOFFCORP", key: "playoff" }, { word: "ACTIONPACKED", key: "actionpacked" },
  { word: "MAJORLEAGUEMARKETING", key: "mlm" },
];

/** Long one-word maker logos, matched with one letter misread on a short line of their own. */
const FUZZY_LOGOS: { word: string; key: string }[] = [
  { word: "DONRUSS", key: "donruss" }, { word: "BOWMAN", key: "bowman" }, { word: "PINNACLE", key: "pinnacle" },
  { word: "SKYBOX", key: "skybox" }, { word: "PARKHURST", key: "parkhurst" }, { word: "SPORTFLICS", key: "sportflics" },
];

type BrandPick = {
  brand: string; subSet: string | null; sport: Sport | null; sportWeight: number; lines: Line[];
  /** Independent places that name the brand: a logo on the front, a logo on the back, a copyright line (0 to 3). */
  signs: number;
  /** Lines that named the set as a product ("PRIZM"), for the set's own signs. */
  setLines: Line[];
};

/** Where a hit stands, for counting independent signs: a logo on one side, a copyright line, or other text. */
function hitKind(h: BrandHit): string | null {
  if (h.logo) return `logo-${h.line.side}`;
  if (isCopyrightLine(h.line)) return "copyright";
  return isSentence(h.line) ? null : `text-${h.line.side}`;
}

/**
 * The brand. Returns null when two makers of different families are both
 * named as a logo or in a copyright line: signs that contradict each other
 * leave the brand blank (12R.5 round 2). Licence text is never a hit.
 */
function pickBrand(hits: BrandHit[], year: number | null): BrandPick | null {
  if (hits.length === 0) return null;
  const scores = new Map<string, number>();
  const has = (k: string) => hits.some((h) => h.def.key === k);
  const leafIncOnly = has("leafinc") && !has("leaf");
  const brandOf = (h: BrandHit): string | null => {
    if (h.def.key === "leafinc") {
      // Donruss cards carry "Leaf, Inc." in the copyright line, since Leaf, Inc.
      // owned Donruss. From 1990 the same company also made the Leaf brand, so
      // "Leaf, Inc." alone no longer says which of the two it is.
      if (has("donruss") || (leafIncOnly && year != null && year < 1990)) return "Donruss";
      return leafIncOnly ? null : "Leaf";
    }
    return hitNames(h.def, year).brand;
  };
  for (const h of hits) {
    const brand = brandOf(h);
    if (brand) scores.set(brand, (scores.get(brand) ?? 0) + h.score);
  }
  // A logo name beats the copyright owner ("1991 LEAF, INC" with a DONRUSS
  // logo is Donruss, "PINNACLE BRANDS" with a SCORE logo is Score): when a
  // logo was read, only brands read as a logo are chosen from, the front's first.
  const logoBrands = (side: Side) => new Set(hits.filter((h) => h.logo && h.def.key !== "leafinc" && h.line.side === side).map(brandOf).filter((b): b is string => b !== null));
  const front = logoBrands("front");
  const allowed = front.size > 0 ? front : logoBrands("back");
  let best: string | null = null;
  let bestScore = 0;
  for (const [b, s] of scores) {
    if (allowed.size > 0 && !allowed.has(b)) continue;
    if (s > bestScore) {
      best = b;
      bestScore = s;
    }
  }
  if (!best) return null;
  const chosen = best;
  // A logo or copyright line of a maker outside the chosen one's family.
  const strong = (h: BrandHit) => h.logo || (isCopyrightLine(h.line) && !h.def.weak);
  if (hits.some((h) => strong(h) && brandOf(h) !== null && !sameMaker(brandOf(h)!, chosen))) return null;
  const mine = hits.filter((h) => brandOf(h) === chosen || (h.def.key === "leafinc" && (chosen === "Donruss" || chosen === "Leaf")));
  const sub = mine.find((h) => hitNames(h.def, year).set);
  const sportDef = mine.find((h) => h.def.sport);
  const kinds = new Set(mine.map(hitKind).filter((k): k is string => k !== null));
  // The same family's copyright line ("Leaf, Inc." for Donruss, "Pinnacle Brands" for Score) agrees too.
  if (hits.some((h) => isCopyrightLine(h.line) && brandOf(h) !== null && sameMaker(brandOf(h)!, chosen))) kinds.add("copyright");
  const subSet = sub ? hitNames(sub.def, year).set : null;
  return {
    brand: chosen,
    subSet,
    sport: sportDef?.def.sport ?? null,
    sportWeight: sportDef?.def.sportWeight ?? 0,
    lines: mine.map((h) => h.line),
    signs: Math.min(3, kinds.size),
    setLines: subSet ? hits.filter((h) => hitNames(h.def, year).set === subSet).map((h) => h.line) : [],
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

/**
 * The set, only when read as text: a set logo ("STADIUM CLUB", "ULTRA",
 * "SELECT"), a subset word by the brand ("TOPPS TRADED"), or a traded or
 * update card number. Never the brand copied in to fill it: "Fleer" is wrong
 * for a Fleer Ultra card whose foil logo could not be read.
 */
function findSetName(pick: BrandPick | null, lines: Line[], cardNumber: string | null): string | null {
  if (pick?.subSet) return pick.subSet;
  for (const l of lines) {
    if (l.tokens.length > 2 || isCopyrightLine(l)) continue;
    const words = l.lz.replace(/[^A-Z ]/g, "").trim();
    for (const [re, set] of SET_LOGOS) if (re.test(words)) return set;
  }
  if (!pick) return null;
  const brandLines = new Set(pick.lines);
  for (const [re, word] of SUBSET_WORDS) {
    if (lines.some((l) => (brandLines.has(l) || l.tokens.length <= 2) && re.test(l.lz))) return `${pick.brand} ${word}`;
  }
  if (cardNumber) {
    if ((pick.brand === "Topps" || pick.brand === "Score") && /T/.test(cardNumber)) return `${pick.brand} Traded`;
    if (pick.brand === "Fleer" && /^U/.test(cardNumber)) return "Fleer Update";
  }
  return null;
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

/** Where a lone number counts as printed in a corner: this close to two edges of the card. */
const CORNER_X = 0.25;
const CORNER_Y = 0.18;

type CornerNumber = { number: string; top: boolean };

/**
 * A short number standing alone in a corner of the back ("65", "101", "98T").
 * Not a stat (another number on the same row beside it), not a decimal, not
 * a position ("1B"), never a year (four digits).
 */
function numberFromCorner(l: Line, side: Line[]): CornerNumber | null {
  const t = l.tokens;
  const traded = t.length === 2 && /^[Tt]$/.test(t[1]);
  if (t.length !== 1 && !traded) return null;
  const b = l.box;
  const top = b.y < CORNER_Y;
  const bottom = b.y + b.h > 1 - CORNER_Y;
  const corner = b.x < CORNER_X || b.x + b.w > 1 - CORNER_X;
  if (!(top || bottom) || !corner) return null;
  if (upper(t[0]) in POS_TOKENS || /[.,]\d/.test(t[0])) return null;
  const n = withTradedSuffix(numberToken(t[0], false), t[1]);
  if (!n) return null;
  // A stat table cell has numbers beside it on its row.
  const beside = side.some(
    (o) => o !== l && /\d/.test(o.raw) && !/[A-Za-z]{3}/.test(o.raw) && sameRow(o, l) && Math.abs(o.box.x + o.box.w / 2 - (b.x + b.w / 2)) < 0.25,
  );
  return beside ? null : { number: n, top };
}

/** True when a line names a playing position ("GUARD", "SS", "LINEBACKER"). */
function positionLine(l: Line): boolean {
  return l.tokens.some((t) => posFromToken(upper(t), false) !== null) || POS_WORDS.some(([re]) => re.test(l.lz));
}

/**
 * "#67" printed with the position ("GUARD #67", or "GUARD" right above it)
 * is the player's jersey number, not the card number (12R.5). Only the "#"
 * form: "No." is how makers mark the card number.
 */
function jerseyNumber(l: Line, side: Line[]): boolean {
  if (!l.tokens.some((t) => t.startsWith("#"))) return false;
  if (positionLine(l)) return true;
  const h = Math.min(l.box.w, l.box.h);
  return side.some((o) => {
    if (o === l || o.tokens.length > 2 || !positionLine(o)) return false;
    const g = boxGap(l.box, o.box);
    return g.dx <= 1.5 * h && g.dy <= 1.5 * h;
  });
}

/** The one value of a list, or null when it is empty or holds two different values. */
function onlyValue(values: string[]): string | null {
  const set = new Set(values);
  return set.size === 1 ? values[0] : null;
}

type NumberFind = { number: string; sure: boolean };

/**
 * The card number: printed alone in a top corner of the back (two different
 * ones: none), else a "No." or "#" marker (back, then front), else alone in a
 * bottom corner of the back. Numbers on the front's picture (jerseys) are
 * never card numbers, so the front counts only with a marker.
 *
 * Sure (12R.5 round 2) when two signs agree: a corner number and a marker
 * with the same number, markers on both sides (a holder label and the back),
 * or the number read the same by two reads of its spot. A marker or a top
 * corner that gives a different number contradicts it: no number.
 */
function findCardNumber(back: Line[], front: Line[]): NumberFind | null {
  const cornerLines = back.map((l) => ({ l, c: numberFromCorner(l, back) })).filter((x): x is { l: Line; c: CornerNumber } => x.c !== null);
  const markers = (side: Line[]) => side.flatMap((l) => {
    const n = numberFromMarkers(l);
    return n && !jerseyNumber(l, side) ? [{ l, n }] : [];
  });
  const backMarks = markers(back);
  const frontMarks = markers(front);
  const top = cornerLines.filter((x) => x.c.top);
  let number: string | null = null;
  let from: Line[] = [];
  if (top.length > 0) {
    number = onlyValue(top.map((x) => x.c.number));
    from = top.map((x) => x.l);
  } else if (backMarks.length > 0) {
    number = backMarks[0].n;
    from = [backMarks[0].l];
  } else if (frontMarks.length > 0) {
    number = frontMarks[0].n;
    from = [frontMarks[0].l];
  } else {
    const bottom = cornerLines.filter((x) => !x.c.top);
    number = onlyValue(bottom.map((x) => x.c.number));
    from = bottom.map((x) => x.l);
  }
  if (!number) return null;
  const n = number;
  // Each place that read a number: the back's corners, its first marker, the front's first marker.
  const reads = [onlyValue(top.map((x) => x.c.number)), backMarks[0]?.n ?? null, frontMarks[0]?.n ?? null].filter((v): v is string => v !== null);
  if (reads.some((v) => v !== n)) return null;
  // One line is one sign (12R final review): a lone "#336" in a corner is
  // both a corner number and a marker, yet it was read once. Places that
  // share a line with a place already counted add nothing.
  const groups: Line[][] = [
    top.filter((x) => x.c.number === n).map((x) => x.l),
    backMarks[0]?.n === n ? [backMarks[0].l] : [],
    frontMarks[0]?.n === n ? [frontMarks[0].l] : [],
  ];
  const counted = new Set<Line>();
  let places = 0;
  for (const g of groups) {
    if (g.length === 0 || g.some((l) => counted.has(l))) continue;
    places++;
    for (const l of g) counted.add(l);
  }
  const bottomAgree = top.length === 0 && reads.length > 0 && cornerLines.some((x) => !x.c.top && x.c.number === n && !counted.has(x.l));
  const twice = from.some((l) => l.twice);
  return { number: n, sure: places >= 2 || bottomAgree || twice };
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
    ["San Diego", "Padres"], ["San Francisco", "Giants"], ["Florida", "Marlins", [], 1993, 2011], ["Colorado", "Rockies", [], 1993],
    // Later clubs and moves, so modern cards read too.
    ["Arizona", "Diamondbacks", [], 1998], ["Tampa Bay", "Devil Rays", [], 1998, 2007], ["Tampa Bay", "Rays", [], 2008],
    ["Washington", "Nationals", [], 2005], ["Miami", "Marlins", [], 2012], ["Cleveland", "Guardians", [], 2022],
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
    ["Charlotte", "Hornets", [], 1988], ["Toronto", "Raptors", [], 1995], ["Vancouver", "Grizzlies", [], 1995, 2000],
    ["Memphis", "Grizzlies", [], 2001], ["Oklahoma City", "Thunder", [], 2008], ["New Orleans", "Pelicans", [], 2013],
    ["Brooklyn", "Nets", [], 2012], ["Washington", "Wizards", [], 1997],
  ]),
  ...teams("football", [
    ["Atlanta", "Falcons"], ["Buffalo", "Bills"], ["Chicago", "Bears"], ["Cincinnati", "Bengals"], ["Cleveland", "Browns"],
    ["Dallas", "Cowboys"], ["Denver", "Broncos"], ["Detroit", "Lions"], ["Green Bay", "Packers"], ["Houston", "Oilers", [], 1900, 1996],
    ["Baltimore", "Colts", [], 1900, 1983], ["Indianapolis", "Colts", [], 1984], ["Kansas City", "Chiefs"],
    ["Oakland", "Raiders", [], 1900, 1981], ["Los Angeles", "Raiders", [], 1982, 1994], ["Oakland", "Raiders", [], 1995, 2019],
    ["Los Angeles", "Rams", [], 1900, 1994], ["St. Louis", "Rams", [], 1995, 2015], ["Miami", "Dolphins"], ["Minnesota", "Vikings"],
    ["New England", "Patriots"], ["New Orleans", "Saints"], ["New York", "Giants"], ["New York", "Jets"],
    ["Philadelphia", "Eagles"], ["St. Louis", "Cardinals", [], 1900, 1987], ["Phoenix", "Cardinals", [], 1988, 1993],
    ["Arizona", "Cardinals", [], 1994], ["Pittsburgh", "Steelers"], ["San Diego", "Chargers", [], 1900, 2016],
    ["San Francisco", "49ers", ["FORTY NINERS", "NINERS"]], ["Seattle", "Seahawks"], ["Tampa Bay", "Buccaneers", ["BUCS"]],
    ["Washington", "Redskins", [], 1900, 2019], ["Carolina", "Panthers", [], 1995], ["Jacksonville", "Jaguars", [], 1995],
    ["Baltimore", "Ravens", [], 1996], ["Tennessee", "Titans", [], 1999], ["Houston", "Texans", [], 2002],
    ["Los Angeles", "Chargers", [], 2017], ["Las Vegas", "Raiders", [], 2020], ["Los Angeles", "Rams", [], 2016],
  ]),
  ...teams("hockey", [
    ["Boston", "Bruins"], ["Buffalo", "Sabres"], ["Calgary", "Flames"], ["Chicago", "Blackhawks", ["BLACK HAWKS"]],
    ["Detroit", "Red Wings"], ["Edmonton", "Oilers"], ["Hartford", "Whalers"], ["Los Angeles", "Kings"],
    ["Minnesota", "North Stars", [], 1900, 1992], ["Dallas", "Stars", [], 1993], ["Montreal", "Canadiens"],
    ["New Jersey", "Devils", [], 1982], ["Colorado", "Rockies", [], 1900, 1981], ["New York", "Islanders"],
    ["New York", "Rangers"], ["Philadelphia", "Flyers"], ["Pittsburgh", "Penguins"], ["Quebec", "Nordiques", [], 1900, 1994],
    ["Colorado", "Avalanche", [], 1995], ["St. Louis", "Blues"], ["Toronto", "Maple Leafs"], ["Vancouver", "Canucks"],
    ["Washington", "Capitals"], ["Winnipeg", "Jets"], ["San Jose", "Sharks", [], 1991], ["Ottawa", "Senators", [], 1992],
    ["Tampa Bay", "Lightning", [], 1992], ["Anaheim", "Mighty Ducks", [], 1993, 2006], ["Florida", "Panthers", [], 1993],
    ["Anaheim", "Ducks", [], 2006], ["Nashville", "Predators", [], 1998], ["Carolina", "Hurricanes", [], 1997],
    ["Minnesota", "Wild", [], 2000], ["Columbus", "Blue Jackets", [], 2000], ["Vegas", "Golden Knights", [], 2017],
    ["Seattle", "Kraken", [], 2021],
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

type TeamFind = {
  team: string;
  sport: Sport | null;
  ambiguous: boolean;
  line: Line;
  /** Read with one letter wrong or missing. */
  fuzzy: boolean;
  /** The team's city was read too ("SEATTLE MARINERS"). */
  city: boolean;
  /** The nickname stands on team lines in two places: both sides, or a stat row and another line. */
  twoPlaces?: boolean;
};

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
  "THUNDER", "WILD", "RAYS", "DUCKS", "TITANS", "TEXANS", "RAVENS", "HURRICANES", "PREDATORS", "NATIONALS", "GUARDIANS",
  "WIZARDS", "KRAKEN", "PELICANS", "DIAMONDBACKS",
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

type TeamScore = { score: number; line: Line; lines: Line[] };
type TeamRow = { group: NickGroup; season: number; y: number };
type TeamTally = { scores: Map<NickGroup, TeamScore>; lastRow: TeamRow | null };

function newTally(): TeamTally {
  return { scores: new Map(), lastRow: null };
}

function tallyTeam(tally: TeamTally, group: NickGroup, l: Line) {
  const cur = tally.scores.get(group) ?? { score: 0, line: l, lines: [] };
  cur.score += 1 + (l.side === "front" ? 1 : 0) + (l.tokens.length <= 4 ? 1 : 0);
  if (!cur.lines.includes(l)) cur.lines.push(l);
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
  if (new Set(entries.map((t) => t.sport)).size > 1) return { team: group.display, sport: null, ambiguous: true, line, fuzzy, city: false };
  let pick = entries[entries.length - 1];
  if (year != null) pick = entries.find((t) => year >= t.from && year <= t.to) ?? pick;
  return { team: `${pick.city} ${pick.nick}`, sport: pick.sport, ambiguous: false, line, fuzzy, city: withCity.length > 0 };
}

/**
 * Team reading (10.10). Text alone is a weak clue, so:
 * - `team` (a candidate for the item) only when one nickname was read
 *   exactly, in capitals, on a team line that is not a sentence, and no other
 *   team on a team line or as a close spelling (12R.4: a team named only in
 *   loose text, an opponent in the bio, does not count against it). The
 *   card parser then still asks for a second sign of the team's sport;
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
        tallyTeam(close, group, l);
      }
    }
  }
  // One team on team lines, and no close spelling of another: the card's
  // team. Other teams named only in loose text (an opponent in the bio) do
  // not stand against it; a second team on a team line does.
  if (strong.scores.size === 1 && [...close.scores.keys()].every((g) => strong.scores.has(g))) {
    const [group] = [...strong.scores.keys()];
    const found = strong.scores.get(group)!;
    const team = resolveTeam(group, found.line, lines, year, sportHint, false);
    const sides = new Set(found.lines.map((l) => l.side));
    const rows = found.lines.filter((l) => rowSeason(l.tokens[0] ?? "") != null);
    team.twoPlaces = sides.size > 1 || (rows.length > 0 && rows.length < found.lines.length);
    return { team, hint: null };
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

/** Sport signs of each kind, for certainty: two kinds that agree make the sport sure. */
type SportKinds = Map<Sport, Set<string>>;

function addKind(k: SportKinds | undefined, s: Sport | null | undefined, kind: string) {
  if (!k || !s) return;
  const set = k.get(s) ?? new Set<string>();
  set.add(kind);
  k.set(s, set);
}

/**
 * Words of leagues, tours and governing bodies (12R.5 round 2: each sport
 * from its own words, never a default). "FOOTBALL" next to a soccer league
 * or club is the game the rest of the world calls football.
 */
const SOCCER_RE = /\bFIFA\b|\bUEFA\b|\bLA\s*LIGA\b|\bPREMIER\s*LEAGUE\b|\bMLS\b|\bMAJOR\s*LEAGUE\s*SOCCER\b|\bBUNDESLIGA\b|\bSERIE\s*A\b|\bLIGUE\s*1\b|\bSOCCER\b|\bCHAMPIONS\s*LEAGUE\b|\bEREDIVISIE\b|\bCONCACAF\b/;
/** Soccer clubs named on cards: a known team is a sign of the sport. */
const SOCCER_CLUBS_RE = /\bREAL\s*MADRID\b|\bBARCELONA\b|\bMANCHESTER\s*(?:UNITED|CITY)\b|\bLIVERPOOL\b|\bCHELSEA\s*FC\b|\bARSENAL\b|\bTOTTENHAM\b|\bJUVENTUS\b|\bAC\s*MILAN\b|\bINTER\s*(?:MILAN|MIAMI)\b|\bBAYERN\b|\bBORUSSIA\b|\bPARIS\s*SAINT\s*-?\s*GERMAIN\b|\bATLETICO\b|\bAJAX\b|\bLA\s*GALAXY\b|\bSOUNDERS\b|\bTORONTO\s*FC\b|\bNAPOLI\b|\bBENFICA\b|\bPORTO\b|\bCELTIC\s*FC\b/;

const LEAGUE_WORDS: [RegExp, Sport][] = [
  [/\bNATIONAL\s*HOCKEY\s*LEAGUE\b|\bNHL\b|\bNHLPA\b|\bHOCKEY\b/, "hockey"],
  [/\bNATIONAL\s*BASKETBALL\b|\bNBA\b|\bWNBA\b|\bBASKETBALL\b/, "basketball"],
  [/\bNATIONAL\s*FOOTBALL\s*LEAGUE\b|\bNFL\b|\bNFLPA\b|\bUSFL\b|\bFOOTBALL\b/, "football"],
  [/\bMAJOR\s*LEAGUE\b(?!\s*(?:MARKETING|SOCCER))|\bMLB\b|\bMLBPA\b|\bAMERICAN\s*LEAGUE\b|\bNATIONAL\s*LEAGUE\b|\bBASEBALL\b/, "baseball"],
  [SOCCER_RE, "soccer"],
  [/\bPGA\b|\bLPGA\b|\bGOLF\b|\bRYDER\s*CUP\b|\bMASTERS\s*TOURNAMENT\b/, "golf"],
  [/\bNASCAR\b|\bWINSTON\s*CUP\b|\bNEXTEL\s*CUP\b|\bSPRINT\s*CUP\b|\bINDY\s*CAR\b|\bFORMULA\s*(?:1|ONE)\b|\bRACING\b|\bSPEEDWAY\b/, "racing"],
  [/\bWWE\b|\bWWF\b|\bWCW\b|\bAEW\b|\bTNA\b|\bWRESTLING\b|\bWRESTLEMANIA\b/, "wrestling"],
  [/\bBOXING\b|\bWBC\b|\bWBA\b|\bIBF\b|\bWBO\b/, "boxing"],
  // Mixed martial arts and other single sports without a list of their own.
  [/\bUFC\b|\bMMA\b/, "other"],
];

const STAT_WORDS: Partial<Record<Sport, string[]>> = {
  baseball: ["RBI", "ERA", "AB", "HR", "SB", "IP", "SLG", "OBP", "2B", "3B"],
  basketball: ["FGA", "FTA", "REB", "AST", "STL", "BLK", "FG%", "FT%", "PCT"],
  football: ["YDS", "TD", "TDS", "RUSHING", "RECEIVING", "PASSING", "SACKS", "COMP"],
  hockey: ["PIM", "PPG", "SHG", "GWG", "GAA", "+/-"],
  soccer: ["APPS", "CAPS", "CLEAN", "SHEETS", "GLS"],
  golf: ["EVENTS", "CUTS", "BIRDIES", "PUTTS", "STROKE"],
  racing: ["POLES", "LAPS", "DNF", "TOP-5", "TOP-10"],
};

function leagueAndStatVotes(lines: Line[], v: Votes, kinds?: SportKinds) {
  const all = lines.map((l) => l.lz).join("\n");
  const soccer = SOCCER_RE.test(all) || SOCCER_CLUBS_RE.test(all);
  for (const [re, s] of LEAGUE_WORDS) {
    if (s === "football" && soccer && !/\bNFL|\bNATIONAL\s*FOOTBALL|\bUSFL/.test(all)) continue;
    if (re.test(all)) {
      vote(v, s, 2);
      addKind(kinds, s, "league");
    }
  }
  if (SOCCER_CLUBS_RE.test(all)) {
    vote(v, "soccer", 2);
    addKind(kinds, "soccer", "team");
  }
  const tokens = new Set(lines.flatMap((l) => (l.tokens.length >= 3 ? l.up.split(" ") : [])));
  for (const [s, words] of Object.entries(STAT_WORDS) as [Sport, string[]][]) {
    const found = words.filter((w) => tokens.has(w)).length;
    if (found >= 2) {
      vote(v, s, 2);
      addKind(kinds, s, "stats");
    } else if (found === 1) vote(v, s, 0.5);
  }
}

/**
 * An Olympic card: the Olympic committee or Olympic cards named outside
 * running text (a set title, a license line), and no league or stat table of
 * one sport. A bio that mentions Olympic gold does not make one.
 */
function isOlympicCard(lines: Line[]): boolean {
  const named = lines.some((l) => !isSentence(l) && /\bUSOC\b|\bOLYMPIC\s*(?:CARDS?|COMMITTEE)\b|\bU\.?\s*S\.?\s*OLYMPIC\b/.test(l.lz));
  if (!named) return false;
  const votes: Votes = new Map();
  leagueAndStatVotes(lines, votes);
  return ![...votes.values()].some((w) => w >= 2);
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
  [/\bMIDFIELDER\b/, "MF", "soccer"],
  [/\bSTRIKER\b/, "ST", "soccer"],
  [/\bGOALKEEPER\b/, "GK", "soccer"],
  [/\bDEFENDER\b/, "DF", "soccer"],
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

/** The first position read that fits `sport` (when known): a basketball card has no hockey "LW". */
function findPosition(lines: Line[], sport: Sport | null = null): PosFind | null {
  const ok = (p: PosFind | null): p is PosFind => p !== null && (!sport || !p.sport || p.sport === sport);
  for (const l of lines) {
    const t = l.tokens;
    const posIdx = t.findIndex((x) => /^POS(?:ITION)?[.:]?$/i.test(x));
    if (posIdx >= 0) {
      const p = posFromToken(t[posIdx + 1] ?? "", true);
      if (ok(p)) return p;
    }
    if (t.length > 6) continue;
    for (let i = 0; i < t.length; i++) {
      const singleOk = t.length <= 4 && i === t.length - 1;
      const p = posFromToken(t[i], singleOk);
      if (ok(p)) return p;
    }
  }
  for (const l of lines) {
    if (l.tokens.length > 6) continue;
    for (const [re, position, posSport] of POS_WORDS) if (re.test(l.lz) && ok({ position, sport: posSport })) return { position, sport: posSport };
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
    // Section headings and set titles on fronts and backs ("HALL OF FAME",
    // "RECENT MAJOR LEAGUE PERFORMANCE", "CAREER HIGHLIGHTS", "GOLD MEDAL").
    "HALL", "FAME", "HALLOF", "RECENT", "PERFORMANCE", "COMPLETE", "MINOR", "PROFILE", "REPORT", "SCOUTING", "BIOGRAPHY",
    "VITAL", "STATISTICS", "STATS", "HONORS", "ACHIEVEMENTS", "MILESTONES", "MONTHLY", "SCOREBOARD", "GOLD", "SILVER",
    "BRONZE", "MEDAL", "MEDALS", "MEDALIST", "OLYMPICS", "GAMES", "CHAMPION", "CHAMPIONSHIP", "CHAMPIONSHIPS",
    "TOURNAMENT", "CLASSIC", "INDUCTED", "INDUCTEE", "ENTERPRISES", "MARKETING", "LICENSEE", "COMMITTEE", "OFFICIAL",
    "PRESIDENT", "EDITION", "CERTIFIED", "SERIAL", "NUMBERED", "PANINI", "PRIZM", "SELECT", "IMPEL", "FLAIR", "FINEST",
    "CHROME", "SPORTFLICS", "PLAYOFF", "WILD", "BRANDS", "TRADING",
    // Product names (12R.5 round 2): never a player's name.
    "OPTIC", "MOSAIC", "CONTENDERS", "ABSOLUTE", "CHRONICLES", "HERITAGE", "SPX", "METAL", "UNIVERSE", "ICE", "GUNS",
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

/**
 * One word of a name. Accents never block a read: the word is checked
 * without them ("\u00c1LVARO" as "ALVARO", same key) and kept as printed.
 */
function nameWord(printed: string): NameWord | null {
  const tok = printed.normalize("NFC");
  const plainTok = tok.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const accented = plainTok !== tok && plainTok.length === tok.length;
  const base = accented ? plainTok : tok;
  const start = base.length - base.replace(/^[^A-Za-z0-9]+/, "").length;
  let s = base.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9.']+$/, "");
  if (!s) return null;
  let fixed = false;
  const letters = s.replace(/[^A-Za-z]/g, "");
  const ups = letters.replace(/[^A-Z]/g, "").length;
  if (s.length >= 3 && letters.length >= 2 && ups / Math.max(letters.length, 1) >= 0.6 && /[01|5l]/.test(s)) {
    const digits = (s.match(/\d/g) ?? []).length;
    if (digits <= 2) {
      s = s.replace(/0/g, "O").replace(/[1|l]/g, "I").replace(/5/g, "S");
      fixed = true;
    }
  }
  if (/^(?:[A-Za-z]\.){1,3}$/.test(s)) return { word: s.toUpperCase(), key: s.toUpperCase().replace(/\./g, ""), initials: true };
  if (!/^[A-Za-z][A-Za-z'-]*[A-Za-z]\.?$/.test(s)) return null;
  const plain = s.replace(/\.$/, "");
  const word = accented && !fixed ? tok.slice(start, start + plain.length) : plain;
  return { word, key: plain.toUpperCase().replace(/[^A-Z]/g, ""), initials: false };
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

/** Removes team names with a city ("Chicago White Sox") so the city is not read as a name. */
const MASK_RES: RegExp[] = TEAMS.flatMap((t) =>
  [t.nick, ...t.alts].map((v) => new RegExp(`\\b(?:${phraseRe(t.city)}\\s*)?${phraseRe(v)}\\b`, "g")),
);

/**
 * Product names of more than one word ("BLACK DIAMOND", "YOUNG GUNS",
 * "ALLEN & GINTER") are masked too: their words are also surnames.
 */
const PRODUCT_MASK_RES: RegExp[] = BRANDS
  .filter((d) => d.set && /\\s\*/.test(d.re.source))
  .map((d) => new RegExp(d.re.source.replace(/^\^/, "\\b").replace(/\$$/, "\\b").replace(/\|\^/g, "|\\b").replace(/\$\|/g, "\\b|"), "g"));

function maskTeams(l: Line): string[] {
  let work = l.lz;
  for (const re of [...MASK_RES, ...PRODUCT_MASK_RES]) work = work.replace(re, (m) => " ".repeat(m.length));
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

/**
 * A name as read on one line: title cased words and a suffix ("Jr."). `cut`:
 * the line ends in a cut off suffix ("KEN GRIFFEY, J"), so the name is not
 * whole unless the other side shows the suffix.
 */
type NameRead = { words: string[]; suffix: string | null; line: Line; header: boolean; cut?: boolean };

/** Lines with labels ("BORN:", "HOME:") hold places and dates, not the name. */
function labelLine(l: Line): boolean {
  return l.tokens.some((t) => /[A-Za-z]:$/.test(t));
}

/** Names of 2 or 3 words on one line (not a sentence), each with the suffix written after it. */
function nameRuns(l: Line): NameRead[] {
  const out: NameRead[] = [];
  const tokens = maskTeams(l);
  let run: NameWord[] = [];
  let suffix: string | null = null;
  let cut = false;
  const flush = () => {
    // Drop vowel-less OCR scraps at either end ("ALEX RODRIGUEZ GML").
    let core = run;
    while (core.length > 0 && !core[core.length - 1].initials && !/[AEIOUY]/.test(core[core.length - 1].key)) core = core.slice(0, -1);
    while (core.length > 0 && !core[0].initials && !/[AEIOUY]/.test(core[0].key)) core = core.slice(1);
    // Names are printed with capitals ("BOB MILACKI", "Bob Milacki"); words in
    // lower case are running text ("round secondary phase").
    // A particle at the end belongs to the next word, never to this name ("SMITH DE": the position DE).
    while (core.length > 0 && NAME_PARTICLES.has(core[core.length - 1].word.toLowerCase())) core = core.slice(0, -1);
    const particles = core.filter((w, i) => i > 0 && NAME_PARTICLES.has(w.word.toLowerCase())).length;
    const capitals = core.every((w, i) => /^\p{Lu}/u.test(w.word) || (i > 0 && NAME_PARTICLES.has(w.word)));
    // Two or three name words; a fourth only with a particle ("Oscar De La Hoya").
    if (capitals && core.length >= 2 && core.length <= 3 + Math.min(1, particles) && !core.every((w) => w.initials) && looksLikeName(core)) {
      const plainKey = normalizeName(core.map((w) => w.word).join(" "));
      if (!CITY_KEYS.has(plainKey)) out.push({ words: core.map((w) => titleWord(w.word)), suffix, line: l, header: false, cut });
    }
    run = [];
    suffix = null;
    cut = false;
  };
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    const w = nameWord(tok);
    if (!w) {
      // "GRIFFEY, J" at the end of the line: the suffix was cut off (glare, the photo's edge).
      if (run.length >= 2 && ti === tokens.length - 1 && /,$/.test(tokens[ti - 1] ?? "") && /^[JjSs]\.?$/.test(tok)) cut = true;
      flush();
      continue;
    }
    if (w.key in SUFFIXES && !w.initials) {
      if (run.length >= 2) suffix = SUFFIXES[w.key];
      flush();
      continue;
    }
    // "de" or "DE" between name words is part of the name, not the position DE.
    const nextWord = nameWord(tokens[ti + 1] ?? "");
    const particle = run.length > 0 && NAME_PARTICLES.has(w.word.toLowerCase()) && nextWord !== null && /^\p{Lu}/u.test(nextWord.word);
    if (STOP_WORDS.has(w.key) && !particle) {
      flush();
      continue;
    }
    run.push(w);
    // A comma ends a name unless a suffix follows ("Griffey, Jr."), or what is left of one at the line's end.
    if (/,$/.test(tok)) {
      const next = tokens[ti + 1];
      const nw = next ? nameWord(next) : null;
      const cutNext = next !== undefined && ti + 1 === tokens.length - 1 && /^[JjSs]\.?$/.test(next);
      if ((!nw || !(nw.key in SUFFIXES)) && !cutNext) flush();
    }
  }
  flush();
  return out;
}

/** The back's heading: in the top part of the card, in type at least as tall as the back's usual line. */
const HEADING_TOP = 0.3;
/** Team nicknames that are also the name of a sport. */
const SPORT_NAME_NICKS = /\bAthletics$/;
/** A heading this much taller than the usual line is large type: it stands against a different front name. */
const HEADING_LARGE = 1.25;
/** A front name read without its space keeps at most this many letters of its first name (misread ones). */
const BANNER_PREFIX = 3;

function middle(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Names in the back's heading: the top part of the card, in large type, not a
 * sentence; or the name header pattern ("Ken Griffey, Jr. * OF"). A name
 * printed in two lines ("ROBERT" over "MILACKI") is joined.
 */
function backHeadings(back: Line[]): { names: NameRead[]; header: PosFind | null } {
  const usual = middle(back.filter((l) => l.raw.replace(/[^A-Za-z0-9]/g, "").length >= 3).map((l) => l.box.h));
  const top = back.filter((l) => l.box.y + l.box.h / 2 < HEADING_TOP && !runningText(l) && !labelLine(l) && l.tokens.length <= 7);
  const large = (l: Line) => usual > 0 && l.box.h >= usual;
  const names: NameRead[] = [];
  let header: PosFind | null = null;
  for (const l of top) {
    const head = headerName(l);
    if (head) {
      header = header ?? head.pos;
      names.push({ words: head.words.map((w) => titleWord(w.word)), suffix: head.suffix, line: l, header: true });
      continue;
    }
    if (large(l)) names.push(...nameRuns(l));
  }
  // A heading set all in lower case ("ray allen"), a style some sets use:
  // a name only when its first word is a common given name (12R.5).
  for (const l of back) {
    const words = l.tokens;
    if (l.box.y + l.box.h / 2 >= HEADING_TOP || !(usual > 0 && l.box.h >= HEADING_LARGE * usual)) continue;
    if (words.length < 2 || words.length > 3 || !words.every((w) => /^[a-z][a-z'-]*[a-z]$/.test(w)) || !GIVEN_NAMES.has(words[0])) continue;
    const core = words.map((w) => nameWord(w)).filter((w): w is NameWord => w !== null);
    if (core.length === words.length && looksLikeName(core)) names.push({ words: words.map(titleWord), suffix: null, line: l, header: false });
  }
  // One name word a line, stacked: joined top to bottom when the lines touch and share a column.
  const singles = top
    .filter((l) => large(l) && l.tokens.length === 1)
    .map((l) => ({ l, w: nameWord(l.tokens[0]) }))
    .filter((x): x is { l: Line; w: NameWord } => x.w !== null && !x.w.initials && !STOP_WORDS.has(x.w.key) && /[AEIOUY]/.test(x.w.key))
    .sort((a, b) => a.l.box.y - b.l.box.y);
  for (let i = 0; i + 1 < singles.length; i++) {
    const a = singles[i].l.box;
    const b = singles[i + 1].l.box;
    const gap = b.y - (a.y + a.h);
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (gap < Math.max(a.h, b.h) && overlapX > 0.5 * Math.min(a.w, b.w) && Math.max(a.h, b.h) < 1.6 * Math.min(a.h, b.h)) {
      const words = [singles[i].w, singles[i + 1].w];
      if (looksLikeName(words)) names.push({ words: words.map((w) => titleWord(w.word)), suffix: null, line: singles[i].l, header: false });
      i++;
    }
  }
  names.sort((x, y) => y.line.box.h - x.line.box.h);
  return { names, header };
}

function surnameKey(n: NameRead): string {
  return normalizeName(n.words[n.words.length - 1]).replace(/[^a-z]/g, "");
}

/** Same surname, or one letter apart in a surname of 5 or more letters (a misread letter). */
function sameSurname(a: NameRead, b: NameRead): boolean {
  const x = surnameKey(a);
  const y = surnameKey(b);
  if (x === y) return x.length > 0;
  if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 1) return false;
  return editDistance(x, y) <= 1;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Common given names one letter apart from `name` (same length, one letter changed). */
function nearGivenNames(name: string): string[] {
  const out: string[] = [];
  for (const g of GIVEN_NAMES) {
    if (g.length !== name.length) continue;
    let diff = 0;
    for (let i = 0; i < g.length && diff < 2; i++) if (g[i] !== name[i]) diff++;
    if (diff === 1) out.push(g);
  }
  return out;
}

/**
 * The first name, checked against common given names (12R.5). A first name
 * that is not a common one but one letter away from one ("Fose", "Jose") is
 * a misread letter, often the same on both sides (same type). It is put
 * right only when the card's other text names the player with exactly one
 * of the near names ("Jose tied a club record"); otherwise the name is
 * unsure and left out (null). Names not near a common one stay as read.
 */
function checkFirstName(words: string[], lines: Line[]): string | null {
  if (words.length < 2) return words[0] ?? null;
  const key = words[0].toLowerCase().replace(/[^a-z]/g, "");
  if (key.length < 3 || key !== words[0].toLowerCase() || GIVEN_NAMES.has(key)) return words[0];
  const near = nearGivenNames(key);
  if (near.length === 0) return words[0];
  const read = new Set(lines.flatMap((l) => l.raw.toLowerCase().split(/[^a-z]+/)));
  const found = near.filter((n) => read.has(n));
  return found.length === 1 ? titleWord(found[0]) : null;
}

function display(n: NameRead, suffix: string | null = n.suffix): string {
  return [...n.words, ...(suffix ? [suffix] : [])].join(" ");
}

export type PlayerPick = {
  /** The player's name, or null when no trustworthy name was read. */
  player: string | null;
  /** The name as written on each side that agrees (same person), the chosen form first. */
  names: string[];
  /** True when front and back agree on the name. */
  agree: boolean;
  keyMatch: string | null;
  hint: string | null;
  header: PosFind | null;
  nameLines: Set<Line>;
  /** The first name was put right by the given name check (one letter changed): not sure. */
  corrected?: boolean;
  /** The name is backed by a second place on the card (see nameEcho). */
  echo?: boolean;
};

/**
 * The player's name (12R.4). Taken from the front: the largest name-like
 * text (box height). The back counts only with its heading (top of the card,
 * large type) or name header, never running text, stat headers or section
 * headings. When the two agree (the same surname: BOB MILACKI and ROBERT
 * MILACKI) the front's form is used, with a suffix (Jr., Sr., II, III) when
 * either side shows it with the name. A front name printed without its space
 * ("BOBMILACKI") is split at the back heading's surname. With no front name
 * the back heading is used. No trustworthy name: none.
 */
function choosePlayer(front: Line[], back: Line[]): PlayerPick {
  const nameLines = new Set<Line>();
  let hint: string | null = null;
  const frontReads: NameRead[] = [];
  const glued: Line[] = [];
  for (const l of front) {
    // A name is never taken from a sentence; its first word may be a first name hint.
    if (isSentence(l)) {
      hint = hint ?? firstNameOf(l);
      continue;
    }
    const head = headerName(l);
    if (head) frontReads.push({ words: head.words.map((w) => titleWord(w.word)), suffix: head.suffix, line: l, header: true });
    // Long lines are not names, except a slab label that packs everything on one line.
    if (l.tokens.length > 8 && !GRADE_RE.test(l.up) && !/#\s*\d/.test(l.raw)) continue;
    if (labelLine(l)) continue;
    frontReads.push(...nameRuns(l));
    const only = l.tokens.length === 1 ? l.tokens[0].replace(/[^A-Za-z]/g, "") : "";
    if (only.length >= 7 && only === only.toUpperCase() && !STOP_WORDS.has(only)) glued.push(l);
  }
  for (const l of back) if (isSentence(l)) hint = hint ?? firstNameOf(l);
  const { names: heads, header } = backHeadings(back);
  // Largest first; a name filling its line before one inside a longer line.
  const fill = (n: NameRead) => (n.words.length + (n.suffix ? 1 : 0)) / Math.max(1, n.line.tokens.filter((t) => /[A-Za-z0-9]/.test(t)).length);
  frontReads.sort((a, b) => b.line.box.h - a.line.box.h || fill(b) - fill(a));
  for (const n of [...frontReads, ...heads]) nameLines.add(n.line);

  let chosen: NameRead | null = null;
  let other: NameRead | null = null;
  let suffix: string | null = null;
  let agree = false;
  for (const f of frontReads) {
    const h = heads.find((b) => sameSurname(b, f));
    if (h) {
      // The front's form of the name; a surname spelled two ways is taken from the clearer read.
      chosen = surnameKey(f) === surnameKey(h) || f.line.conf >= h.line.conf ? f : { ...f, words: [...f.words.slice(0, -1), h.words[h.words.length - 1]] };
      other = h;
      agree = true;
      suffix = f.suffix ?? h.suffix;
      break;
    }
  }
  if (!chosen) {
    // "BOBMILACKI": the front name without its space, split at the back's surname.
    for (const g of glued) {
      const key = g.tokens[0].replace(/[^A-Za-z]/g, "").toUpperCase();
      for (const h of heads) {
        const sur = h.words[h.words.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
        const first = key.slice(0, key.length - sur.length);
        if (sur.length >= 3 && key.endsWith(sur) && first.length >= 2 && /[AEIOUY]/.test(first) && !STOP_WORDS.has(first)) {
          chosen = { words: [titleWord(first), titleWord(sur)], suffix: null, line: g, header: false };
          other = h;
          agree = true;
          suffix = h.suffix;
          nameLines.add(g);
          break;
        }
      }
      if (chosen) break;
    }
  }
  // "NMHARDAWAY": the front name without its space and with its first name
  // misread (tiny or foil print, 12R.7). The back's name in large type (a
  // banner, wherever it sits on the back) whose surname ends the front's word
  // gives the whole name. Two places agree on the surname only, so the name
  // stays unsure.
  let fromBanner = false;
  if (!chosen && glued.length > 0) {
    const usual = middle(back.filter((l) => l.raw.replace(/[^A-Za-z0-9]/g, "").length >= 3).map((l) => l.box.h));
    const banners = back
      .filter((l) => usual > 0 && l.box.h >= HEADING_LARGE * usual && !isSentence(l) && !labelLine(l))
      .flatMap((l) => nameRuns(l))
      .filter((n) => n.words.length >= 2);
    for (const g of glued) {
      const word = g.tokens[0].replace(/[^A-Za-z]/g, "").toUpperCase();
      const hit = banners.find((b) => {
        const sur = b.words[b.words.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
        return sur.length >= 5 && word.endsWith(sur) && word.length - sur.length <= BANNER_PREFIX;
      });
      if (hit) {
        chosen = hit;
        agree = true;
        suffix = hit.suffix;
        fromBanner = true;
        nameLines.add(g);
        nameLines.add(hit.line);
        break;
      }
    }
  }
  if (!chosen && frontReads.length > 0) {
    // Front and back name different people: a name header with a position
    // ("CAL RIPKEN, JR. SS") on the back beats the front; a large heading
    // that is not the front's name leaves the name unsettled.
    const lead = heads[0];
    const usual = middle(back.filter((l) => l.raw.replace(/[^A-Za-z0-9]/g, "").length >= 3).map((l) => l.box.h));
    if (lead?.header) {
      chosen = lead;
    } else if (lead && lead.line.box.h >= HEADING_LARGE * usual) {
      return { player: null, names: [], agree: false, keyMatch: null, hint, header, nameLines };
    } else {
      chosen = frontReads[0];
    }
    suffix = chosen.suffix;
  }
  if (!chosen && heads.length > 0) {
    chosen = heads[0];
    suffix = chosen.suffix;
  }
  if (!chosen) return { player: null, names: [], agree: false, keyMatch: null, hint, header, nameLines };
  // "KEN GRIFFEY, J" and no side shows the whole suffix: Jr. or Sr. is unknown, so no name.
  if (chosen.cut && !suffix) return { player: null, names: [display(chosen)], agree: false, keyMatch: null, hint, header, nameLines };

  const first = checkFirstName(chosen.words, [...front, ...back]);
  if (first === null) return { player: null, names: [display(chosen, suffix)], agree: false, keyMatch: null, hint, header, nameLines };
  const corrected = first !== chosen.words[0] || fromBanner;
  if (corrected) chosen = { ...chosen, words: [first, ...chosen.words.slice(1)] };
  let player = display(chosen, suffix);
  let keyMatch: string | null = null;
  const canonical = KEY_PLAYERS.get(normalizeName(player));
  if (canonical) {
    player = canonical;
    keyMatch = canonical;
  }
  const names = [player];
  if (other) {
    const alt = display(other, suffix);
    if (normalizeName(alt) !== normalizeName(player)) names.push(alt);
  }
  // A second sign of the name (12R.5 round 2): the other side names the
  // same player (agree), or the back's other text uses the name's surname or
  // first name ("Jones led the Bolles School", "Jim's most productive game").
  const echo = agree || nameEcho(chosen, back, nameLines);
  return { player, names, agree, keyMatch, hint, header, nameLines, corrected, echo };
}

/**
 * Names that are also everyday English words ("Young", "Will", "Rice"). In
 * a bio such a word proves the name only where its capital letter cannot
 * come from anything else: inside a sentence, or right beside the other
 * half of the name (12R final review). Lower case, letters only.
 */
const COMMON_NAME_WORDS = new Set(`
young will rice brown white green black gray grey hill king price long little bell wood woods stone rose bird fox
strong hunter cash may best moon hope grant frank mark bill art rich chase drew pat rusty jack ray guy rod sandy
dusty mo bob rob van miles major marshall bishop parker cook baker mason miller walker carter porter fisher taylor
turner page hall house ford field fields lane love joy sharp short small swift wise wolf lamb bass pike nice early
law lord earl duke prince knight hale hart west north south east sims day night winter summer spring snow frost hay
lee rush lynch power powers temple wells banks ball bush case cross dean dale hand bonds lucky storm reed
`.trim().split(/\s+/));

/** The surname, or the first name, of a read name used as a name in other lines of the back. */
function nameEcho(name: NameRead, back: Line[], nameLines: ReadonlySet<Line>): boolean {
  const key = (w: string) => normalizeName(w).replace(/[^a-z]/g, "");
  const surname = key(name.words[name.words.length - 1]);
  const given = key(name.words[0]);
  const words = [surname, given].filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  return back.some((l) => {
    if (l === name.line || nameLines.has(l)) return false;
    // A heading in capitals: every word is capitalised, which proves nothing for an everyday word.
    const allCaps = /\p{Lu}/u.test(l.raw) && !/\p{Ll}/u.test(l.raw);
    const toks = [...l.raw.matchAll(/\p{L}+/gu)].map((m) => ({ text: m[0], at: m.index ?? 0, key: key(m[0]) }));
    return toks.some((t, i) => {
      const hit = words.find((w) => t.key === w || (t.key.endsWith("s") && t.key.slice(0, -1) === w));
      if (!hit) return false;
      // The surname as a name: written with a capital ("the young passer" is a word).
      if (!/^\p{Lu}/u.test(t.text)) return false;
      if (!COMMON_NAME_WORDS.has(hit)) return true;
      const before = l.raw.slice(0, t.at).trimEnd();
      const sentenceStart = before === "" || /[.!?:;"(\u201c]$/.test(before);
      if (!allCaps && !sentenceStart) return true;
      // At a sentence start or in a heading: only with the other half of the name beside it.
      const other = hit === surname ? given : surname;
      return toks[i - 1]?.key === other || toks[i + 1]?.key === other;
    });
  });
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

/**
 * A holder label (or any line) that prints the year and the maker on one
 * line: "1997 UPPER DECK", "2003-04 TOPPS CHROME" (season sets by their
 * first year), "1990 TOPPS #336 KEN GRIFFEY JR.". Any maker or product of
 * the brand table counts, with its era.
 */
function slabLabelYearBrand(lines: Line[]): { year: number; brand: string; line: Line } | null {
  for (const l of lines) {
    // Copyright lines are read by findYear with their own rules (Leaf, Inc. and Donruss).
    if (isCopyrightLine(l)) continue;
    const m = /(?:^|\s)((?:19[5-9]\d|20[0-3]\d)(?:-(?:19|20)?\d{2})?)\s+(\S.*)$/.exec(l.up);
    if (!m) continue;
    const year = m[1].includes("-") ? seasonYear(m[1]) : validYear(Number(m[1]));
    const rest = makeLine(m[2], l.conf, l.box, l.side, l.source);
    if (year == null || !rest) continue;
    for (const h of brandHits([rest])) {
      if (h.def.copyrightOnly || h.def.key === "leafinc" || h.def.key === "udc") continue;
      const brand = hitNames(h.def, year).brand;
      if (brand && rest.lz.search(h.def.re) <= 1) return { year, brand, line: l };
    }
    // Labels cut short often keep only "1997 UPPER".
    if (/^UPPER\b/.test(rest.lz)) return { year, brand: "Upper Deck", line: l };
  }
  return null;
}

const MONTH_RE = /\b(?:JAN|FEB|MAR|APR|MAY|JUNE?|JULY?|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\.?(?=\s|$)/;

/** Running text: a sentence, or two or more words in lower case ("pitchers to no-hit"). */
function runningText(l: Line): boolean {
  return isSentence(l) || l.tokens.filter((t) => /^[a-z][a-z'-]+[.,;:!?]*$/.test(t)).length >= 2;
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
    // A print run number is stamped on its own ("12/99", "No. 045/100",
    // "SERIAL 12/99"). In running text "14/91" is a date ("no-hit A's 7/
    // 14/91"), so lines of running text and long lines never give one.
    const serialWords = /\bSERIAL\b|\bNUMBERED\b|\bPRINT\s*RUN\b|\bLIMITED\b|\bEDITION\b/.test(l.lz);
    if (!serialWords && (runningText(l) || l.tokens.length > 4 || MONTH_RE.test(l.lz))) continue;
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
    yearSigns: 0,
    yearFromStats: false,
    brandSigns: 0,
    brand: null,
    setName: null,
    cardNumber: null,
    player: null,
    playerAgree: false,
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
    certainty: {},
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
  const slab = findSlab([...front, ...back]);
  const label = slabLabelYearBrand(lines);
  // On a graded holder the label's line counts as the label (a strong sign);
  // on a bare card the same kind of line only fills a year nothing else gave.
  const slabLabel = slab ? label : null;
  const seen = { conflict: false };
  let yearFind = findCardYear(front, back, lines, new Set(hits.map((h) => h.line)), seen);
  if (seen.conflict) ev.push("The years printed on the card do not agree, so the year is left for you");
  if (!yearFind && !slab && label && !seen.conflict) yearFind = { year: label.year, how: "brand", signs: 1 };
  // A holder label prints the card's year plainly: it is the best sign. When
  // the card's own signs give another year, the label's year is used, unsure.
  if (yearFind && slabLabel && slabLabel.year !== yearFind.year) {
    ev.push(`The holder label says ${slabLabel.year}, the card's own print says ${yearFind.year}`);
    yearFind = null;
  }
  out.year = yearFind?.year ?? slabLabel?.year ?? null;
  out.yearSigns = yearFind?.signs ?? (slabLabel ? 1 : 0);
  out.yearFromStats = yearFind?.how === "stats";
  const pick = pickBrand(hits, out.year);
  out.brand = pick?.brand ?? slabLabel?.brand ?? (yearFind && label && !slab ? label.brand : null);
  out.brandSigns = pick?.signs ?? (slabLabel ? 1 : 0);
  if (slabLabel) {
    // The holder label's line is one sign (12R final review): the label and
    // the card's own print read from that same line are not two. A field is
    // sure from the label only when a line other than the label agrees.
    const notLabel = (ls: Line[]) => ls.filter((l) => l !== slabLabel.line);
    const otherHits = hits.filter((h) => h.line !== slabLabel.line);
    const otherYear = findCardYear(notLabel(front), notLabel(back), notLabel(lines), new Set(otherHits.map((h) => h.line)));
    if (out.year === slabLabel.year) out.yearSigns = Math.min(3, 1 + (otherYear?.year === slabLabel.year ? otherYear.signs : 0));
    const otherPick = pickBrand(otherHits, out.year);
    if (out.brand === slabLabel.brand) out.brandSigns = Math.min(3, 1 + (otherPick?.brand === slabLabel.brand ? otherPick.signs : 0));
  }
  if (!yearFind && slabLabel) ev.push(`Read ${slabLabel.year} ${slabLabel.brand} on the holder label`);

  if (yearFind?.how === "front") {
    ev.push(`Read year ${yearFind.year} next to the brand name on the front`);
  } else if (yearFind?.logoYear) {
    ev.push(`Read copyright line ${yearFind.copyright} and the year '${String(yearFind.year).slice(2)} in a logo on the back, so the card is from ${yearFind.year}`);
  } else if (yearFind?.how === "copyright" && yearFind.year !== yearFind.copyright) {
    ev.push(`Read copyright line: ${yearFind.copyright}${out.brand ? ` ${out.brand}` : ""}, and a stat table ending with ${yearFind.lastSeason}, so the card is from ${yearFind.year}`);
  } else if (yearFind?.how === "copyright") {
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

  const numberFind = findCardNumber(back, front);
  out.cardNumber = numberFind?.number ?? null;
  if (out.cardNumber) ev.push(`Read card number ${out.cardNumber}`);

  out.setName = findSetName(pick, lines, out.cardNumber);
  if (out.setName && out.setName !== out.brand) ev.push(`Read set: ${out.setName}`);

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
  // Autograph words count outside running text only: "Signed by Orioles",
  // "signed as a free agent" and "his signature pitch" are about the player's
  // career. "SIGNED" alone is never one; "HAND SIGNED" and "AUTOGRAPH" are.
  const labelUp = lines.filter((l) => !runningText(l)).map((l) => l.up).join(" ");
  // "AUT" is the short form on Beckett and PSA/DNA authentication labels.
  const labelAut = /\bAUT\b/.test(labelUp) && /\bBECKETT|\bPSA\b|\bBAS\b|\bJSA\b/.test(labelUp);
  const words = /\bAUTO(?:GRAPH(?:ED|S)?)?\b|\bSIGNATURES?\b|\bHAND\s*-?\s*SIGNED\b|\bPSA\s*\/?\s*DNA\b|\bAUTHENTIC\s+AUTOGRAPH/.test(labelUp);
  if (labelAut || words) {
    out.isAutograph = true;
    ev.push("Autograph wording read on the card or label");
  }
  if (/\bREPRINT\b/.test(allUp)) {
    out.isReprint = true;
    ev.push("The card says REPRINT: it is a later copy, not the original card");
  }

  // Sport clues other than the team, so they can settle a team name used in two sports.
  // League and sport words in running text ("He played 3 years of football")
  // are about the player's life: they count for little.
  // Kinds of sign per sport (12R.5 round 2): the sport is never guessed, it
  // needs a positive sign, and it is sure only when two kinds agree.
  const kinds: SportKinds = new Map();
  const votes: Votes = new Map();
  if (pick) {
    vote(votes, pick.sport, pick.sportWeight);
    addKind(kinds, pick.sport, "product");
  }
  leagueAndStatVotes(lines.filter((l) => !isSentence(l)), votes, kinds);
  const prose: Votes = new Map();
  leagueAndStatVotes(lines.filter((l) => isSentence(l)), prose);
  for (const [sp, w] of prose) vote(votes, sp, w / 4);
  const players = choosePlayer(front, back);
  // Positions must fit the sport the other clues point to. The position in a
  // name header ("Ken Griffey, Jr. * OF") beats one read elsewhere.
  const before = winner(new Map([...votes].filter(([, w]) => w >= 1)));
  const header = players.header && (!before || !players.header.sport || players.header.sport === before) ? players.header : null;
  const pos = header ?? findPosition([...front, ...back], before);
  if (pos) {
    out.position = pos.position;
    vote(votes, pos.sport, 2);
    addKind(kinds, pos.sport, "position");
    ev.push(`Read position: ${pos.position}`);
  }
  // An Olympic or other multi-sport card: "Athletics" there is track and field.
  const olympic = isOlympicCard(lines);
  const backRows = tableRows(back);
  const { team, hint } = olympic
    ? { team: null, hint: null }
    : findTeam([...front, ...back, ...backRows], out.year, winner(votes), players.nameLines, pos);
  // A nickname alone is not enough: the team's city, or a second sign of its
  // sport (league words, stat headers, a position, the maker) must be read too.
  const supported = (t: TeamFind) => !t.ambiguous && t.sport !== null && (t.city || (votes.get(t.sport) ?? 0) > 0);
  if (team && supported(team)) {
    out.team = team.team;
    vote(votes, team.sport, 3);
    addKind(kinds, team.sport, "team");
    ev.push(`Read team: ${team.team}`);
  } else if (team || hint) {
    const h = (team ?? hint)!;
    // "COWBOYS" with the baseball position SS: signs that disagree, no hint.
    // "Athletics" is also the name of a sport (track and field, on Olympic
    // and other multi-sport cards): without the team's city or a sign of
    // baseball it stays a hint but says nothing about the sport, so it never
    // makes the card a baseball card (12R.7).
    const sportName = SPORT_NAME_NICKS.test(h.team) && !h.city && !((votes.get(h.sport ?? "other") ?? 0) > 0);
    if (!h.ambiguous && h.sport && !(pos?.sport && pos.sport !== h.sport)) {
      out.teamHint = h.team;
      out.teamHintSport = h.sport;
      // A hint says half as much about the sport as a team read for sure.
      if (!sportName) vote(votes, h.sport, 3 * FUZZY_WEIGHT);
      ev.push(`Maybe team ${h.team} (not sure, check it)`);
    } else if (h.ambiguous) {
      ev.push(`Read team name ${h.team}, but it is used in more than one sport`);
    }
  }
  const top = winner(votes);
  const others = [...kinds].filter(([sp]) => sp !== top);
  if (olympic) out.sport = "other";
  else if (top && others.length > 0) {
    // Signs of two sports outside running text contradict each other: no sport.
    out.sport = null;
    ev.push(`Read signs of more than one sport: ${[top, ...others.map(([sp]) => sp)].join(", ")}`);
  } else if (top && (kinds.get(top) || out.teamHintSport === top)) out.sport = top;
  if (olympic) ev.push("Olympic card: sport other, no team");

  // A season sport card (basketball, hockey, soccer) with only a copyright
  // year: the copyright may show either year of the season (\u00a91993 on a
  // 1993-94 set, \u00a91999 on a 1998-99 one), so the year read stays, unsure.

  out.player = players.player;
  out.playerAgree = players.agree;
  out.playerCandidates = players.names;
  out.firstNameHint = players.hint;
  if (players.keyMatch) ev.push(`Name matches the key card list: ${players.keyMatch}`);

  // Certainty per filled field (12R.5 round 2): sure only when two
  // independent signs on the card agree, else unsure.
  const sure: Record<CertainField, boolean> = {
    player: players.echo === true && !players.corrected,
    year: out.yearSigns >= 2,
    brand: out.brandSigns >= 2,
    cardNumber: numberFind?.sure === true,
    setName: setSure(pick, out.setName),
    sport: !olympic && out.sport != null && [...(kinds.get(out.sport) ?? [])].length >= 2 && others.length === 0,
    team: out.team != null && team != null && (team.city || team.twoPlaces === true),
  };
  for (const f of CERTAIN_FIELDS) {
    if (out[f] != null) out.certainty[f] = sure[f] ? "sure" : "unsure";
  }
  return out;
}


/**
 * A set is sure when its product name was read in two places (front and back
 * logos), or once as a logo with its maker named in another place.
 */
function setSure(pick: BrandPick | null, setName: string | null): boolean {
  if (!pick || !setName || pick.subSet !== setName) return false;
  const places = new Set(pick.setLines);
  if (places.size >= 2) return true;
  return pick.lines.some((l) => !places.has(l) && !isSentence(l));
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
    // A product label names its line ("1990 TOPPS BASEBALL"): the brand is the set unless a set was read.
    out.setName = findSetName(pick, lines, null) ?? pick.brand;
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
