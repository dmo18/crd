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
  team: string | null;
  sport: Sport | null;
  position: string | null;
  /** From a graded holder (slab) label. */
  grader: string | null;
  grade: string | null;
  certNumber: string | null;
  /** "045/100" style. */
  serialNumber: string | null;
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

function makeLine(text: string, conf: number, box: LineBox, side: Side): Line | null {
  const raw = cleanRaw(text);
  if (!raw) return null;
  const up = upper(raw);
  return { raw, up, lz: letterize(up), tokens: raw.split(" "), conf, box, side };
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
      const line = makeLine(l.text, num(l.confidence, 0.5), box, side);
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

type YearFind = { year: number; how: "copyright" | "brand" | "stats"; score: number; line?: Line; lastSeason?: number };

/** Year from a stat table: last season shown plus one, only for clearly consecutive seasons. */
function yearFromStats(lines: Line[]): YearFind | null {
  const seasons = new Set<number>();
  for (const l of lines) {
    const t = l.tokens;
    if (t.length < 4) continue;
    const first = t[0].replace(/^'/, "");
    let start: number | null = null;
    let m = /^(?:19)?([5-9]\d)$/.exec(first);
    if (m) start = 1900 + Number(m[1]);
    m = /^(?:19)?([5-9]\d)-(?:19)?(\d{2})$/.exec(first);
    if (m && (Number(m[1]) + 1) % 100 === Number(m[2])) start = 1900 + Number(m[1]);
    if (start == null) continue;
    const numbers = t.slice(1).filter((x) => /^[\d.]+%?$/.test(x)).length;
    if (numbers < 3) continue;
    seasons.add(start);
  }
  const list = [...seasons].sort((a, b) => a - b);
  if (list.length < 2) return null;
  for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] !== 1) return null;
  const last = list[list.length - 1];
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
    for (const t of l.tokens) {
      const y = fixedYear(t);
      if (y == null) continue;
      const sideBonus = l.side === "back" ? 1 : 0;
      if (copyright) consider({ year: y, how: "copyright", score: 5 + sideBonus, line: l });
      else consider({ year: y, how: "brand", score: 3 + sideBonus, line: l });
      break;
    }
  }
  const stats = yearFromStats(lines);
  if (stats) consider(stats);
  return best;
}

// ---------------------------------------------------------------------------
// Brands

type BrandDef = { key: string; brand: string; set?: string; re: RegExp; copyrightOnly?: boolean; sport?: Sport; sportWeight?: number };

const BRANDS: BrandDef[] = [
  { key: "udminor", brand: "Upper Deck", set: "Upper Deck Minor League", re: /\bUPPER\s*DECK\s*MINOR\s*LEAGUE\b/g, sport: "baseball", sportWeight: 2 },
  { key: "sp", brand: "Upper Deck", set: "SP", re: /\bUPPER\s*DECK\s*SP\b|^SP$/g },
  { key: "stadiumclub", brand: "Topps", set: "Stadium Club", re: /\bSTADIUM\s*CLUB\b/g },
  { key: "ultra", brand: "Fleer", set: "Fleer Ultra", re: /\bULTRA\b/g },
  { key: "topps", brand: "Topps", re: /\bTOPPS\b/g },
  { key: "upperdeck", brand: "Upper Deck", re: /\bUPPER\s*DECK\b/g },
  { key: "fleer", brand: "Fleer", re: /\bFLEER\b/g },
  { key: "donruss", brand: "Donruss", re: /\bDONRUS{1,2}\b/g, sport: "baseball", sportWeight: 1 },
  { key: "score", brand: "Score", re: /\bSCORE\b/g },
  { key: "bowman", brand: "Bowman", re: /\bBOWMAN\b/g },
  { key: "opc", brand: "O-Pee-Chee", re: /\bO\s*-?\s*PEE\s*-?\s*CHEE\b|\bOPC\b/g },
  { key: "leafinc", brand: "Leaf", re: /\bLEAF\s*,?\s*INC\b/g },
  { key: "leaf", brand: "Leaf", re: /\bLEAF\b(?!\s*,?\s*INC)/g },
  { key: "proset", brand: "Pro Set", re: /\bPRO\s*SET\b/g, sport: "football", sportWeight: 1 },
  { key: "hoops", brand: "NBA Hoops", re: /\bHOOPS\b/g, sport: "basketball", sportWeight: 2 },
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
        hits.push({ def, line: l, score: 1 + (copyright ? 3 : 0) + (short ? 2 : 0) + (hasYear ? 1 : 0) + (l.side === "back" ? 0.5 : 0) });
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
    // Donruss cards of the 1980s carry "Leaf, Inc." in the copyright line.
    if (h.def.key === "leafinc" && (has("donruss") || (leafIncOnly && year != null && year < 1990))) brand = "Donruss";
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
  const mine = hits.filter((h) => h.def.brand === best || (best === "Donruss" && h.def.key === "leafinc"));
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

function numberFromMarkers(l: Line): string | null {
  const t = l.tokens;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (/^(?:N[O0o]|n[o0])[.:]?$/.test(tok) && (t.length <= 6 || i <= 1)) {
      const n = numberToken(t[i + 1], true);
      if (n) return n;
    }
    let m = /^(?:N[O0o]|n[o0])[.:]([0-9A-Za-z|-]+)$/.exec(tok);
    if (m && (t.length <= 6 || i <= 1)) {
      const n = numberToken(m[1], true);
      if (n) return n;
    }
    m = /^#(.*)$/.exec(tok);
    if (m) {
      const n = numberToken(m[1] || t[i + 1], true);
      if (n) return n;
    }
  }
  return null;
}

function numberFromCorner(l: Line): string | null {
  if (l.tokens.length !== 1) return null;
  const top = l.box.y < 0.2;
  const corner = l.box.x < 0.3 || l.box.x + l.box.w > 0.7;
  if (!top || !corner) return null;
  return numberToken(l.tokens[0], false);
}

function findCardNumber(back: Line[], front: Line[]): string | null {
  for (const l of back) {
    const n = numberFromMarkers(l);
    if (n) return n;
  }
  for (const l of back) {
    const n = numberFromCorner(l);
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

type TeamFind = { team: string; sport: Sport | null; ambiguous: boolean; line: Line };

function findTeam(lines: Line[], year: number | null, sportHint: Sport | null): TeamFind | null {
  const scores = new Map<NickGroup, { score: number; line: Line }>();
  for (const l of lines) {
    let work = l.lz;
    for (const v of VARIANTS) {
      v.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = v.re.exec(work)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (!excludedNick(v.group.key, l.lz.slice(0, start), l.lz.slice(end))) {
          const cur = scores.get(v.group) ?? { score: 0, line: l };
          cur.score += 1 + (l.side === "front" ? 1 : 0) + (l.tokens.length <= 4 ? 1 : 0);
          scores.set(v.group, cur);
        }
        work = work.slice(0, start) + " ".repeat(end - start) + work.slice(end);
        v.re.lastIndex = end;
      }
    }
  }
  if (scores.size === 0) return null;
  const all = lines.map((l) => l.lz).join("\n");
  const cityHit = (t: TeamDef) => CITY_RES.get(t.city)?.test(all) ?? false;

  let bestGroup: NickGroup | null = null;
  let best = -1;
  let bestLine: Line | null = null;
  for (const [g, s] of scores) {
    const total = s.score + (g.entries.some(cityHit) ? 2 : 0);
    if (total > best) {
      best = total;
      bestGroup = g;
      bestLine = s.line;
    }
  }
  if (!bestGroup || !bestLine) return null;

  let entries = bestGroup.entries;
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
  if (new Set(entries.map((t) => t.sport)).size > 1) {
    return { team: bestGroup.display, sport: null, ambiguous: true, line: bestLine };
  }
  let pick = entries[entries.length - 1];
  if (year != null) pick = entries.find((t) => year >= t.from && year <= t.to) ?? pick;
  return { team: `${pick.city} ${pick.nick}`, sport: pick.sport, ambiguous: false, line: bestLine };
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
  [/\bMAJOR\s*LEAGUE\b|\bMLB\b|\bMLBPA\b|\bAMERICAN\s*LEAGUE\b|\bNATIONAL\s*LEAGUE\b|\bBASEBALL\b/, "baseball"],
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
    "MLBPA", "NFLPA", "NHLPA", "OLYMPIC", "UNIVERSITY", "COLLEGE", "SCHOOL", "HIGH", "ACADEMY", "SERIES", "WORLD", "HIGHLIGHTS", "HIGHLIGHT", "MVP", "AWARD", "CYCLE",
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

function findPlayers(front: Line[], back: Line[]): { names: string[]; keyMatch: string | null } {
  const found = new Map<string, Candidate>();
  let keyMatch: string | null = null;
  for (const l of [...front, ...back]) {
    // Long lines are sentences, except a slab label that packs everything on one line.
    if (l.tokens.length > 8 && !GRADE_RE.test(l.up) && !/#\s*\d/.test(l.raw)) continue;
    // Lines with labels ("BORN:", "HOME:") hold places and dates, not the name.
    if (l.tokens.some((t) => /[A-Za-z]:$/.test(t))) continue;
    const tokens = maskTeams(l);
    const lineWords = l.tokens.length;
    let run: NameWord[] = [];
    let suffix: string | null = null;
    const flush = () => {
      const core = run;
      if (core.length >= 2 && core.length <= 3 && !core.every((w) => w.initials)) {
        const plainKey = normalizeName(core.map((w) => w.word).join(" "));
        if (!CITY_KEYS.has(plainKey)) {
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
      if (STOP_WORDS.has(w.key)) {
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
  return { names: names.slice(0, 5), keyMatch };
}

// ---------------------------------------------------------------------------
// Slabs and serial numbers

const GRADE_RE =
  /\b(GEM\s*-?\s*MI?N?T|PRISTINE|NM\s*-?\s*MT\+?|EX\s*-?\s*MT|VG\s*-?\s*EX|MINT|NM|EX|VG|GOOD|FAIR|POOR)\s*\+?\s*(10|[1-9](?:\.5)?)(?![\d.])/;

type SlabFind = { grader: string | null; grade: string | null; certNumber: string | null };

function findSlab(lines: Line[]): SlabFind | null {
  const all = lines.map((l) => l.up).join("\n");
  let grader: string | null = null;
  if (/\bPSA\b/.test(all)) grader = "PSA";
  else if (/\bBGS\b|\bBECKETT\s*GRADING\b/.test(all)) grader = "BGS";
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
  // A grade word without a grader or a cert number is too weak to call it a slab.
  if (!grader && !certNumber) return null;
  return { grader, grade, certNumber };
}

function findSerial(lines: Line[]): string | null {
  for (const l of lines) {
    if (/\bBORN\b/.test(l.lz) || /\d+\/\d+\/\d+/.test(l.raw)) continue;
    const re = /(^|[^\d/])(\d{1,4})\s*\/\s*(\d{2,4})(?![\d/])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.raw)) !== null) {
      const a = Number(m[2]);
      const b = Number(m[3]);
      if (a >= 1 && b >= 10 && a <= b) return `${m[2]}/${m[3]}`;
    }
  }
  return null;
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
    team: null,
    sport: null,
    position: null,
    grader: null,
    grade: null,
    certNumber: null,
    serialNumber: null,
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
  const yearFind = findYear(lines, new Set(hits.map((h) => h.line)));
  out.year = yearFind?.year ?? null;
  const pick = pickBrand(hits, out.year);
  out.brand = pick?.brand ?? null;

  if (yearFind?.how === "copyright") {
    ev.push(out.brand ? `Read copyright line: ${yearFind.year} ${out.brand}` : `Read copyright line: ${yearFind.year}`);
  } else if (yearFind?.how === "brand") {
    ev.push(`Read year ${yearFind.year} next to the brand name`);
  } else if (yearFind?.how === "stats") {
    ev.push(`Read stat table ending with ${yearFind.lastSeason}, so the card is likely from ${yearFind.year}`);
  }
  if (out.brand && yearFind?.how !== "copyright") ev.push(`Read brand: ${out.brand}`);

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

  out.serialNumber = findSerial(lines);
  if (out.serialNumber) ev.push(`Read serial number ${out.serialNumber}`);

  // Sport clues other than the team, so they can settle a team name used in two sports.
  const votes: Votes = new Map();
  if (pick) vote(votes, pick.sport, pick.sportWeight);
  leagueAndStatVotes(lines, votes);
  const pos = findPosition([...front, ...back]);
  if (pos) {
    out.position = pos.position;
    vote(votes, pos.sport, 2);
    ev.push(`Read position: ${pos.position}`);
  }
  const team = findTeam([...front, ...back], out.year, winner(votes));
  if (team) {
    out.team = team.team;
    if (team.ambiguous) ev.push(`Read team name ${team.team}, but it is used in more than one sport`);
    else {
      vote(votes, team.sport, 3);
      ev.push(`Read team: ${team.team}`);
    }
  }
  out.sport = winner(votes);

  const players = findPlayers(front, back);
  out.playerCandidates = players.names;
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
