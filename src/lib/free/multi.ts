import { GIVEN_NAMES } from "./given-names";
import { normalizeBrand } from "./key-cards";
import type { OcrResult } from "./ocr";
import { parseCardText, type ParsedCard } from "./parse";

/**
 * Many cards in one photo (12R.7): which found card is a back, and which
 * front and back (in different photos of one scan) are the same card. Pure
 * rules on the text read from each card on its own; no pixels here.
 */

/** Shown on a card when the scan had fronts and backs but this side found no partner. */
export const ONE_SIDE_NOTE = "Only one side of this card was matched. Add the other side or check the details.";

/** A back usually shows at least this many of the signs below. */
const BACK_SIGNS = 2;
/** So much text is a back whatever it says (fronts carry a name, a team, a logo). */
const BACK_LINES = 14;
const STAT_WORDS = new Set([
  "G", "GP", "GS", "AB", "R", "H", "HR", "RBI", "AVG", "BA", "SB", "BB", "SO", "ERA", "IP", "W", "L", "SV", "PCT", "OBP", "SLG",
  "PTS", "REB", "AST", "STL", "BLK", "MIN", "FG", "FT", "FG%", "FT%", "PPG", "RPG", "APG",
  "ATT", "YDS", "TD", "TDS", "INT", "REC", "COMP", "SACKS", "TKL", "LG",
  "PIM", "GA", "GAA", "SV%", "A", "P", "YEAR", "CLUB", "TEAM",
]);

/** A copyright or printing line: a back's. */
const COPYRIGHT = /©|\(c\)\s*\d{2}|\bCOPYRIGHT\b|\bPRINTED\s+IN\b|\bLICENSED\b|\bALL\s+RIGHTS\b|\b(?:CORP|INC)\b\.?/i;

/**
 * Whether the text read from one card is its back. A back shows several of:
 * a copyright or printing line, running text (a short life story), a stat
 * table heading, height, weight, birth or school lines. A front shows a name,
 * a team and a logo, rarely more.
 */
export function looksLikeBack(read: OcrResult | null): boolean {
  if (!read) return false;
  const lines = read.lines.map((l) => l.text).filter((t) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3);
  if (lines.length >= BACK_LINES) return true;
  let signs = 0;
  const all = lines.join("\n");
  if (COPYRIGHT.test(all)) signs++;
  if (lines.some((t) => t.split(/\s+/).filter((w) => /^[a-z]{2,}[,.;]?$/.test(w)).length >= 4)) signs++;
  if (lines.some((t) => t.toUpperCase().split(/\s+/).filter((w) => STAT_WORDS.has(w)).length >= 3)) signs++;
  if (/\b(?:HEIGHT|WEIGHT|BORN|BIRTHPLACE|HOMETOWN|COLLEGE|DRAFTED|ACQ|HT|WT|BATS|THROWS|SHOOTS)\b|\bDATE\s+OF\s+BIRTH\b/i.test(all)) signs++;
  if (lines.length >= BACK_LINES / 2) signs++;
  return signs >= BACK_SIGNS;
}

/** One card found in one photo of the scan, as read on its own. */
export type SideRead = { photo: number; text: OcrResult | null; back: boolean };

/** Lower case letters only, for comparing name words. */
function key(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/** The front's name words without a suffix: given name first, surname last. */
function nameWords(player: string | null): string[] {
  if (!player) return [];
  return player.split(/\s+/).map(key).filter((w) => w.length > 0 && !SUFFIXES.has(w));
}

/** Words written with a capital letter on the back (a name is), in lower case. */
function capitalWords(read: OcrResult | null): Set<string> {
  const out = new Set<string>();
  for (const l of read?.lines ?? []) {
    for (const m of l.text.matchAll(/\p{L}[\p{L}'.-]*/gu)) {
      if (!/^\p{Lu}/u.test(m[0])) continue;
      // "MILLS'" or "Hardaway's": the name with a possessive.
      const w = key(m[0].replace(/'s$/i, ""));
      if (w.length >= 2) out.add(w);
    }
  }
  return out;
}

/** The given name and the surname on one line of the back, next to each other or with one word between ("Frank E. Thomas"). */
function namedTogether(read: OcrResult | null, given: string, surname: string): boolean {
  for (const l of read?.lines ?? []) {
    const ws = [...l.text.matchAll(/\p{L}[\p{L}'.-]*/gu)].map((m) => key(m[0].replace(/'s$/i, "")));
    for (let i = 0; i < ws.length; i++) {
      if (ws[i] !== given) continue;
      if (ws[i + 1] === surname || ws[i + 2] === surname) return true;
    }
  }
  return false;
}

function same(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return key(a) === key(b);
}

type Parsed = { front: ParsedCard; back: ParsedCard };

/**
 * How well a front and a back fit as one card, 0 when they do not. The
 * surname read on the front must appear on the back as a name (with a
 * capital), and the back must be that player's own: its parsed name (the
 * heading in large type at the top) has the surname, or the front's given
 * name stands with the surname on one line. A bare surname in a story is
 * not enough. The back's heading naming the same player and the given name
 * on the back each add to it; maker and team agreeing add a little,
 * disagreeing take away.
 */
export function pairScore(front: SideRead, back: SideRead, parsed?: Parsed): number {
  const f = parsed?.front ?? parseCardText(front.text, null);
  const b = parsed?.back ?? parseCardText(null, back.text);
  const both = parseCardText(front.text, back.text);
  // No clean name on the front alone ("NMHARDAWAY"): the name both sides agree on, when they do.
  const words = nameWords(f.player ?? (both.playerAgree ? both.player : null));
  const surname = words[words.length - 1];
  if (!surname || surname.length < 3) return partOfName(front, back, b, f);
  // A back that names its own player with another surname is another card,
  // whatever its story says ("Pasqua and Thomas shared first base").
  const own = nameWords(b.player);
  if (own.length > 0 && own[own.length - 1] !== surname) return 0;
  const onBack = capitalWords(back.text);
  if (!onBack.has(surname)) return 0;
  // The surname alone in running text (another player's story) is not the back's own name: the back
  // must name its player (its heading, parsed above), or show the front's given name with the surname.
  const given = words.length >= 2 && words[0].length >= 2 ? words[0] : null;
  if (own.length === 0 && !(given && namedTogether(back.text, given, surname))) return 0;
  let score = 1;
  if (both.playerAgree) score += 1;
  if (given && onBack.has(given)) score += 1;
  const brand = f.brand && b.brand ? normalizeBrand(f.brand) === normalizeBrand(b.brand) : null;
  const team = same(f.team ?? f.teamHint, b.team ?? b.teamHint);
  const sport = same(f.sport, b.sport);
  for (const agree of [brand, team]) {
    if (agree === true) score += 0.5;
    if (agree === false) score -= 1;
  }
  if (sport === false) score -= 1;
  return score >= 1 ? score : 0;
}

/** A front word this long at least may be the end or the start of a surname whose other part was lost. */
const NAME_PART = 5;

/**
 * The surnames a back gives its own player: its parsed name, else every line
 * of two or three capitalized words that starts with a common given name
 * ("TIM HARDAWAY" over a stat table).
 */
function backSurnames(read: OcrResult | null, b: ParsedCard): string[] {
  const own = nameWords(b.player);
  if (own.length > 0) return [own[own.length - 1]];
  const out = new Set<string>();
  for (const l of read?.lines ?? []) {
    const ws = l.text.trim().split(/\s+/);
    if (ws.length < 2 || ws.length > 3 || !ws.every((w) => /^\p{Lu}[\p{L}'.-]*$/u.test(w))) continue;
    if (!GIVEN_NAMES.has(ws[0].toLowerCase())) continue;
    out.add(key(ws[ws.length - 1]));
  }
  return [...out];
}

/**
 * A front whose name was not read whole ("DAWAY" for Tim Hardaway, the rest
 * lost in glare): it fits a back whose own heading names a player when a
 * front word of 5 letters or more is the start or the end of that surname,
 * and the maker and team do not disagree. The weakest kind of fit (1): any
 * clearer fit wins, and two such fits tie, so nothing is paired then.
 */
function partOfName(front: SideRead, back: SideRead, b: ParsedCard, f: ParsedCard): number {
  const surnames = backSurnames(back.text, b);
  if (surnames.length !== 1 || surnames[0].length <= NAME_PART) return 0;
  const surname = surnames[0];
  const words = (front.text?.lines ?? []).flatMap((l) => l.text.split(/[^\p{L}]+/u)).map(key).filter((w) => w.length >= NAME_PART);
  if (!words.some((w) => w !== surname && (surname.endsWith(w) || surname.startsWith(w)))) return 0;
  if (f.brand && b.brand && normalizeBrand(f.brand) !== normalizeBrand(b.brand)) return 0;
  if (f.sport && b.sport && f.sport !== b.sport) return 0;
  const team = same(f.team ?? f.teamHint, b.team ?? b.teamHint);
  return team === false ? 0 : 1;
}

/**
 * Pairs fronts with backs, one to one, across different photos of a scan.
 * A pair is made only when the front and the back are each other's clear
 * best fit: when two candidates fit equally well, nothing is paired and the
 * sides stay separate. Pairs found take their sides out, and the rest is
 * looked at again. Returns [front index, back index] pairs into `sides`.
 */
export function pairSides(sides: SideRead[]): [number, number][] {
  const fronts = sides.map((s, i) => ({ s, i })).filter((x) => !x.s.back);
  const backs = sides.map((s, i) => ({ s, i })).filter((x) => x.s.back);
  const parsedFront = new Map(fronts.map((x) => [x.i, parseCardText(x.s.text, null)]));
  const parsedBack = new Map(backs.map((x) => [x.i, parseCardText(null, x.s.text)]));
  const score = new Map<string, number>();
  for (const f of fronts) {
    for (const b of backs) {
      if (f.s.photo === b.s.photo) continue;
      const s = pairScore(f.s, b.s, { front: parsedFront.get(f.i)!, back: parsedBack.get(b.i)! });
      if (s > 0) score.set(`${f.i}:${b.i}`, s);
    }
  }
  const at = (f: number, b: number) => score.get(`${f}:${b}`) ?? 0;
  const freeF = new Set(fronts.map((x) => x.i));
  const freeB = new Set(backs.map((x) => x.i));
  /** The one best partner among `others`, or null when none fits or two fit equally. */
  const best = (others: Set<number>, fit: (o: number) => number): number | null => {
    let top = 0;
    let who: number | null = null;
    let tie = false;
    for (const o of others) {
      const s = fit(o);
      if (s <= 0) continue;
      if (s > top) {
        top = s;
        who = o;
        tie = false;
      } else if (s === top) {
        tie = true;
      }
    }
    return tie ? null : who;
  };
  const pairs: [number, number][] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...freeF]) {
      const b = best(freeB, (o) => at(f, o));
      if (b == null || best(freeF, (o) => at(o, b)) !== f) continue;
      pairs.push([f, b]);
      freeF.delete(f);
      freeB.delete(b);
      changed = true;
    }
  }
  return pairs.sort((x, y) => x[0] - y[0]);
}

/** Words that tell one card side from another: words of 4 letters or more, and numbers of 3 digits or more (stat lines). */
function sideWords(read: OcrResult | null): Set<string> {
  const out = new Set<string>();
  for (const l of read?.lines ?? []) {
    for (const m of l.text.matchAll(/[\p{L}]{4,}|\d[\d.]{2,}/gu)) out.add(/\d/.test(m[0]) ? m[0].replace(/\.$/, "") : key(m[0]));
  }
  return out;
}

/** Share of the smaller side's words that the other side has too: a front at least this much, a back (more words, more misreads) this much. */
const SAME_FRONT = 0.8;
const SAME_BACK = 0.5;
/** Backs sharing this many stat numbers need only this share of words. */
const SAME_STATS = 6;
const SAME_BACK_WITH_STATS = 0.4;
/** And at least this many words in common. */
const SAME_FRONT_WORDS = 2;
const SAME_BACK_WORDS = 4;

/**
 * Whether two sides found in different photos of one scan are the same side
 * of the same card, photographed twice (owner scan 8: the three fronts in
 * two photos). Both fronts or both backs; the same player when both name
 * one (or the one name found in the other side's letters, "BOBMILACKI");
 * most of the words and stat numbers of the side with fewer in the other;
 * and no year, maker or card number that differs. Two different cards of
 * one player differ in their words (another year, set, story or stats).
 */
export function sameSide(a: SideRead, b: SideRead, pa?: ParsedCard, pb?: ParsedCard): boolean {
  if (a.photo === b.photo || a.back !== b.back) return false;
  const p = pa ?? (a.back ? parseCardText(null, a.text) : parseCardText(a.text, null));
  const q = pb ?? (b.back ? parseCardText(null, b.text) : parseCardText(b.text, null));
  const surname = (x: ParsedCard) => nameWords(x.player).at(-1) ?? null;
  const letters = (r: OcrResult | null) => key((r?.lines ?? []).map((l) => l.text).join(""));
  const sa = surname(p);
  const sb = surname(q);
  if (sa && sb && sa !== sb) return false;
  if (sa && !sb && !letters(b.text).includes(sa)) return false;
  if (sb && !sa && !letters(a.text).includes(sb)) return false;
  for (const f of ["year", "brand", "cardNumber"] as const) {
    if (p[f] != null && q[f] != null && String(p[f]) !== String(q[f])) return false;
  }
  const wa = sideWords(a.text);
  const wb = sideWords(b.text);
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let common = 0;
  let numbers = 0;
  for (const w of small) {
    if (!large.has(w)) continue;
    common++;
    if (/\d/.test(w)) numbers++;
  }
  if (common < (a.back ? SAME_BACK_WORDS : SAME_FRONT_WORDS)) return false;
  // Backs: many stat numbers in common are the strongest sign (a misread word
  // counts against the share, a stat line read twice does not differ).
  const share = a.back && numbers >= SAME_STATS ? SAME_BACK_WITH_STATS : a.back ? SAME_BACK : SAME_FRONT;
  return common / small.size >= share;
}

/**
 * Sides photographed twice: for each side that repeats one kept, the index
 * of the side kept. Of the repeats the side that gives the most details
 * (year, maker, number, player, team), then the most words, is kept (the
 * better photo), the first one on a tie.
 */
export function repeatedSides(sides: SideRead[]): Map<number, number> {
  const parsed = sides.map((s) => (s.back ? parseCardText(null, s.text) : parseCardText(s.text, null)));
  const size = sides.map((s) => sideWords(s.text).size);
  const fields = parsed.map((p) => (["year", "brand", "cardNumber", "player", "team"] as const).filter((f) => p[f] != null).length);
  const order = sides.map((_, i) => i).sort((x, y) => fields[y] - fields[x] || size[y] - size[x] || x - y);
  const kept: number[] = [];
  const out = new Map<number, number>();
  for (const i of order) {
    const k = kept.find((j) => sides[j].photo !== sides[i].photo && sameSide(sides[j], sides[i], parsed[j], parsed[i]) && ![...out].some(([d, to]) => to === j && sides[d].photo === sides[i].photo));
    if (k === undefined) kept.push(i);
    else out.set(i, k);
  }
  return out;
}

/** One card scan: the share of the front's words the second photo must show too to be the front again. */
const FRONT_AGAIN = 0.6;

/**
 * One card scan where the photo given as the back shows the front again
 * (owner scan 9): it does not look like a back, it shows most of the
 * front's words (at least 2), and it names no other player.
 */
export function frontTwice(front: OcrResult | null, back: OcrResult | null): boolean {
  if (!front || !back || looksLikeBack(back)) return false;
  // Any sign of a back at all (a copyright line, a row of stat numbers) and it is a back, read poorly.
  const lines = back.lines.map((l) => l.text);
  if (lines.some((t) => COPYRIGHT.test(t) || (t.match(/\b\d[\d.]*\b/g) ?? []).length >= 3)) return false;
  const wf = sideWords(front);
  const wb = sideWords(back);
  let common = 0;
  for (const w of wf) if (wb.has(w)) common++;
  if (common < SAME_FRONT_WORDS || common / Math.max(1, wf.size) < FRONT_AGAIN) return false;
  // And it shows little the front does not: its words in capitals (a piece of
  // running text from a card beside it, in small letters, does not count).
  const caps = new Set(back.lines.filter((l) => {
    const letters = l.text.replace(/[^\p{L}]/gu, "");
    return letters.length > 0 && (letters.match(/\p{Lu}/gu) ?? []).length * 2 >= letters.length;
  }).flatMap((l) => [...l.text.matchAll(/\p{L}{4,}/gu)].map((m) => key(m[0]))));
  let shown = 0;
  for (const w of caps) if (wf.has(w)) shown++;
  if (caps.size === 0 || shown / caps.size < FRONT_AGAIN) return false;
  const a = nameWords(parseCardText(front, null).player).at(-1);
  const b = nameWords(parseCardText(back, null).player).at(-1);
  return !(a && b && a !== b);
}
