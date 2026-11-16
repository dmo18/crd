import { SPORTS, type Sport } from "@/db/schema";
import { normalizeBrand } from "./normalize";

/**
 * Pure cleaning rules for what MyCardfolio sends back.
 * Design: docs/PLAN.md, Milestone 10, "Cleaning".
 */

/** Words some entries add after a player's name. Compared in capitals, as written. */
const NAME_TAGS: readonly string[] = [
  "IR", "RC", "TC", "AS", "DP", "UER", "ERR", "COR", "HOF", "SP", "SR", "ROY", "MVP", "CL", "TL", "LL", "UD",
  "NO NAME ON FRONT", "BLACKBOX", "BLACK BOX", "ERROR", "CHECKLIST",
].sort((a, b) => b.split(" ").length - a.split(" ").length);

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
  const cap = (p: string) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p);
  return w
    .split("-")
    .map((part) => part.split("'").map(cap).join("'"))
    .map((part) => {
      const l = part.toLowerCase();
      if (MAC_NAMES.has(l)) return "Mac" + l[3].toUpperCase() + l.slice(4);
      if (/^mc[a-z]{2,}/.test(l)) return "Mc" + l[2].toUpperCase() + l.slice(3);
      return part;
    })
    .join("-");
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
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { name: null, tags: [] };
  let words = text.split(" ");
  const tags: string[] = [];
  for (;;) {
    const hit = NAME_TAGS.find((tag) => {
      const n = tag.split(" ").length;
      return words.length - n >= 2 && words.slice(-n).join(" ") === tag;
    });
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
 * removed, letters kept ("11T"). Anything that is not 1 to 4 digits with up to
 * 3 letters before or 2 after ("or", "6m7", "0p6") becomes null.
 */
export function cleanCardNumber(raw: string | number | null | undefined): string | null {
  let s = String(raw ?? "").toUpperCase().replace(/^\s*(NO\.?|#)\s*/, "").replace(/[#\s]/g, "");
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
].map((brand) => ({ brand, key: normalizeBrand(brand) }));

/**
 * "Topps Tiffany" gives brand "Topps" and variation "Tiffany". A product that
 * starts with no known brand is kept whole as the brand.
 */
export function splitProduct(raw: string | null | undefined): { brand: string | null; variation: string | null } {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { brand: null, variation: null };
  const words = text.split(/[\s]+/);
  for (const b of [...BRANDS].sort((x, y) => y.key.length - x.key.length)) {
    for (let n = words.length; n >= 1; n--) {
      if (normalizeBrand(words.slice(0, n).join(" ")) === b.key) {
        const rest = words.slice(n).join(" ").trim();
        return { brand: b.brand, variation: rest || null };
      }
    }
  }
  return { brand: text, variation: null };
}

/** "Base Set" (or nothing) means the main set and becomes null. */
export function cleanSetName(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
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

/** True when the url is an https address on mycardfolio.com. */
export function isSourceUrl(raw: string | null | undefined): boolean {
  try {
    const u = new URL(String(raw ?? ""));
    return u.protocol === "https:" && u.hostname === "mycardfolio.com" && u.port === "";
  } catch {
    return false;
  }
}

/** A clean entry has an all digit id. Anything else is noise. */
export function isCleanId(id: string): boolean {
  return /^\d{1,12}$/.test(id);
}
