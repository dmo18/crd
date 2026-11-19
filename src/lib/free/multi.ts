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
  if (/©|\(c\)\s*\d{2}|\bCOPYRIGHT\b|\bPRINTED\s+IN\b|\bLICENSED\b|\bALL\s+RIGHTS\b|\b(?:CORP|INC)\b\.?/i.test(all)) signs++;
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

function same(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return key(a) === key(b);
}

type Parsed = { front: ParsedCard; back: ParsedCard };

/**
 * How well a front and a back fit as one card, 0 when they do not. The
 * surname read on the front must appear on the back as a name (in its
 * heading or text, with a capital); the back's heading naming the same
 * player and the given name on the back each add to it; maker and team
 * agreeing add a little, disagreeing take away.
 */
export function pairScore(front: SideRead, back: SideRead, parsed?: Parsed): number {
  const f = parsed?.front ?? parseCardText(front.text, null);
  const b = parsed?.back ?? parseCardText(null, back.text);
  const both = parseCardText(front.text, back.text);
  // No clean name on the front alone ("NMHARDAWAY"): the name both sides agree on, when they do.
  const words = nameWords(f.player ?? (both.playerAgree ? both.player : null));
  const surname = words[words.length - 1];
  if (!surname || surname.length < 3) return 0;
  // A back that names its own player with another surname is another card,
  // whatever its story says ("Pasqua and Thomas shared first base").
  const own = nameWords(b.player);
  if (own.length > 0 && own[own.length - 1] !== surname) return 0;
  const onBack = capitalWords(back.text);
  if (!onBack.has(surname)) return 0;
  let score = 1;
  if (both.playerAgree) score += 1;
  if (words.length >= 2 && words[0].length >= 2 && onBack.has(words[0])) score += 1;
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
