import { SPORTS, type Sport } from "@/db/schema";
import { normalizeBrand } from "./normalize";

/**
 * Pure cleaning rules for what MyCardfolio sends back.
 * Design: docs/PLAN.md, Milestone 10, "Cleaning".
 */

/**
 * Words some entries add after a player's name. Compared in capitals, as written.
 * "SR" is not here: it is part of the name ("Ken Griffey Sr.").
 */
const NAME_TAGS: readonly string[] = [
  "IR", "RC", "TC", "AS", "DP", "UER", "ERR", "COR", "HOF", "SP", "MVP", "CL", "TL", "LL", "UD", "RB", "FDP", "MEM", "MGR",
  "NO NAME ON FRONT", "BLACKBOX", "BLACK BOX", "ERROR", "CHECKLIST",
].sort((a, b) => b.split(" ").length - a.split(" ").length);

/**
 * Tags that can also be a family name ("Patrick Roy"). Taken off only right
 * after a name suffix ("JR ROY"), where no more name can follow.
 */
const NAME_LIKE_TAGS: readonly string[] = ["ROY"];

/** Longest text kept for a name, set, brand or variation. */
export const MAX_TEXT = 200;
/** Most players kept for one card. */
export const MAX_SUBJECTS = 10;

function cut(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT).trim() : s;
}

const SUFFIX = /^(jr|sr)\.?$|^(ii|iii|iv)$/i;
const ROMAN = new Set(["II", "III", "IV"]);
const MAC_NAMES = new Set(["macdonald", "macgregor", "macphail", "macfarlane", "macarthur", "macnamara"]);

function isShouting(s: string): boolean {
  return /[A-Z]/.test(s) && !/[a-z]/.test(s);
}

function capitalizeWord(w: string): string {
  const lower = w.toLowerCase();
  if (lower === "jr" || lower === "jr.") return "Jr.";
  if (lower === "sr" || lower === "sr.") return "Sr.";
  if (ROMAN.has(w.toUpperCase())) return w.toUpperCase();
  if (lower === "st" || lower === "st.") return "St.";
  if (lower === "de" || lower === "van" || lower === "von" || lower === "la" || lower === "di" || lower === "del") {
    return lower[0].toUpperCase() + lower.slice(1);
  }
  // A capital at the start and after "-", ".", "(", "'" and "’": "D.J.", "(Texas)", "O’Neill".
  return w
    .toLowerCase()
    .split(/([-.('’])/)
    .map((part) => {
      if (!part || /^[-.('’]$/.test(part)) return part;
      if (MAC_NAMES.has(part)) return "Mac" + part[3].toUpperCase() + part.slice(4);
      if (/^mc[a-z]{2,}/.test(part)) return "Mc" + part[2].toUpperCase() + part.slice(3);
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("");
}

function fixWord(w: string): string {
  // Jr and Sr get their period even in a name that was already in name case.
  if (/^jr\.?$/i.test(w)) return "Jr.";
  if (/^sr\.?$/i.test(w)) return "Sr.";
  return w;
}

/**
 * "DAN MARINO IR" gives name "Dan Marino" and tag "IR". Tags come only off the
 * end, only when written in capitals, and never leave fewer than two words.
 */
export function cleanName(raw: string | null | undefined): { name: string | null; tags: string[] } {
  const text = cut(String(raw ?? "").replace(/\s+/g, " ").trim());
  if (!text) return { name: null, tags: [] };
  let words = text.split(" ");
  const tags: string[] = [];
  for (;;) {
    const hit =
      NAME_TAGS.find((tag) => {
        const n = tag.split(" ").length;
        return words.length - n >= 2 && words.slice(-n).join(" ") === tag;
      }) ??
      NAME_LIKE_TAGS.find(
        (tag) => words.length >= 4 && words[words.length - 1] === tag && SUFFIX.test(words[words.length - 2]),
      );
    if (!hit) break;
    words = words.slice(0, words.length - hit.split(" ").length);
    tags.unshift(hit);
  }
  const joined = words.join(" ");
  const name = isShouting(joined) ? words.map(capitalizeWord).join(" ") : words.map(fixWord).join(" ");
  return { name: name || null, tags };
}

/**
 * Card number as printed: "#", "No." and spaces removed, capitals, leading zeros
 * removed, letters kept ("11T"). A number with hyphens keeps them, in printed
 * order ("U90-36", "90AS-28"). Anything else ("or", "6m7", "0p6") becomes null.
 * "NO" without a dot is kept: it can be part of the number ("NOV1").
 */
export function cleanCardNumber(raw: string | number | null | undefined): string | null {
  let s = String(raw ?? "").slice(0, 40).toUpperCase().replace(/^\s*(NO\.|#)\s*/, "").replace(/[#\s]/g, "");
  if (/^[A-Z0-9]{1,6}(-[A-Z0-9]{1,6}){1,2}$/.test(s) && /\d/.test(s)) return s;
  s = s.replace(/^([A-Z]{0,3})0+(?=\d)/, "$1");
  return /^[A-Z]{0,3}\d{1,4}[A-Z]{0,2}$/.test(s) ? s : null;
}

/** The first four digits: "1986-87" gives 1986. */
export function cleanYear(raw: string | number | null | undefined): number | null {
  const m = /\d{4}/.exec(String(raw ?? ""));
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1860 && y <= 2100 ? y : null;
}

export function cleanSport(raw: string | null | undefined): Sport | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return (SPORTS as readonly string[]).includes(s) ? (s as Sport) : null;
}

/** Brands named in the catalog, in the spelling the app uses. */
const BRANDS = [
  "O-Pee-Chee", "Upper Deck", "Topps", "Fleer", "Donruss", "Score", "Bowman", "Leaf", "Pro Set", "NBA Hoops", "Hoops",
  "SkyBox", "Pinnacle", "Classic", "Star", "Pacific", "Action Packed", "Pro Cards", "Kellogg's", "Drake's", "Parkhurst",
  "Panini", "Stadium Club", "Collector's Choice", "Sage", "Playoff", "Finest", "Ultra",
].map((brand) => ({ brand, key: normalizeBrand(brand) })).sort((x, y) => y.key.length - x.key.length);

/**
 * "Topps Tiffany" gives brand "Topps" and variation "Tiffany". A product that
 * starts with no known brand is kept whole as the brand.
 */
export function splitProduct(raw: string | null | undefined): { brand: string | null; variation: string | null } {
  const text = cut(String(raw ?? "").replace(/\s+/g, " ").trim());
  if (!text) return { brand: null, variation: null };
  const words = text.split(" ");
  // No brand is longer than 4 words, however it is spelled ("O Pee Chee").
  const heads = words.slice(0, 4).map((_, i) => normalizeBrand(words.slice(0, i + 1).join(" ")));
  for (const b of BRANDS) {
    for (let n = heads.length; n >= 1; n--) {
      if (heads[n - 1] === b.key) {
        const rest = words.slice(n).join(" ").trim();
        return { brand: b.brand, variation: rest || null };
      }
    }
  }
  return { brand: text, variation: null };
}

/** "Base Set" (or nothing) means the main set and becomes null. */
export function cleanSetName(raw: string | null | undefined): string | null {
  const s = cut(String(raw ?? "").replace(/\s+/g, " ").trim());
  return !s || /^base( set)?$/i.test(s) ? null : s;
}

/**
 * The set id from a card's page address ("base-set-9179" gives "9179"), only for
 * https://mycardfolio.com/sports/<sport>/<year>/<product>/<set>/<card>.
 */
export function setIdFromUrl(raw: string | null | undefined): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "mycardfolio.com" || u.port !== "") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "sports" || parts.length < 5) return null;
  const m = /-(\d{1,12})$/.exec(parts[4]);
  return m ? m[1] : null;
}

/**
 * The card's page rebuilt as https://mycardfolio.com + path (no user, query or
 * hash), or null when the url is not an https address on mycardfolio.com.
 */
export function sourceUrl(raw: string | null | undefined): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "mycardfolio.com" || u.port !== "") return null;
  return "https://mycardfolio.com" + u.pathname;
}

/** True when the url is an https address on mycardfolio.com. */
export function isSourceUrl(raw: string | null | undefined): boolean {
  return sourceUrl(raw) !== null;
}

/** A clean entry has an all digit id. Anything else is noise. */
export function isCleanId(id: string): boolean {
  return /^\d{1,12}$/.test(id);
}
