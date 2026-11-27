import { SPORTS, type Sport } from "@/db/schema";
import { SPORT_LABELS } from "@/lib/items/labels";
import { cleanCardNumber } from "@/lib/catalog/clean";
import { normalizeText, printedCardNumber } from "@/lib/catalog/normalize";

/**
 * Which set a card belongs to (Milestone 15): year, brand, set name and sport
 * as read on the item, case, accents and punctuation ignored. A set name that
 * only repeats the brand ("Topps" on a Topps card) or says "Base" is the base
 * set. Built only here, so the Sets list, the set page and the stored rows agree.
 */

export type SetFields = { sport: Sport | null; year: number | null; brand: string | null; setName: string | null };
export type SetIdentity = { sport: Sport | null; year: number; brandKey: string; setKey: string };

const BASE_WORDS = new Set(["base", "base set", "base cards"]);

/** The identity, or null when the card has no year or names no brand or set. */
export function setIdentityOf(f: SetFields): SetIdentity | null {
  if (f.year == null || !Number.isInteger(f.year) || f.year < 1800 || f.year > 2100) return null;
  let brandKey = normalizeText(f.brand ?? "");
  let setKey = normalizeText(f.setName ?? "");
  if (BASE_WORDS.has(setKey) || setKey === brandKey) setKey = "";
  if (!brandKey) [brandKey, setKey] = [setKey, ""];
  if (!brandKey) return null;
  return { sport: f.sport, year: f.year, brandKey: brandKey.slice(0, 60), setKey: setKey.slice(0, 80) };
}

/** The set's key and address part: "1990_topps__baseball". Only a to z, 0 to 9, dashes and underscores. */
export function setKeyOf(id: SetIdentity): string {
  return [String(id.year), id.brandKey.replace(/ /g, "-"), id.setKey.replace(/ /g, "-"), id.sport ?? ""].join("_");
}

export const SET_KEY_RE = /^\d{4}_[a-z0-9-]{1,60}_[a-z0-9-]{0,80}_[a-z]{0,12}$/;

/** A key back to its identity, or null when it is not one this app makes. */
export function parseSetKey(key: string): SetIdentity | null {
  if (!SET_KEY_RE.test(key)) return null;
  const [year, brand, set, sport] = key.split("_");
  if (sport && !(SPORTS as readonly string[]).includes(sport)) return null;
  const brandKey = brand.replace(/-/g, " ");
  const setKey = set.replace(/-/g, " ");
  if (brandKey.trim() !== brandKey || brandKey.includes("  ") || setKey.trim() !== setKey || setKey.includes("  ")) return null;
  return { year: Number(year), brandKey, setKey, sport: (sport || null) as Sport | null };
}

export function keyOfFields(f: SetFields): string | null {
  const id = setIdentityOf(f);
  return id ? setKeyOf(id) : null;
}

/** "1990 Topps" or "1991 Upper Deck SP", from the owner's own spelling. */
export function setTitle(f: { year: number; brand: string | null; setName: string | null; sport: Sport | null }): string {
  const id = setIdentityOf(f);
  // No brand: the set name stands in for it (setIdentityOf does the same).
  const brand = f.brand?.trim() || f.setName?.trim() || "";
  const set = id && id.setKey && f.brand?.trim() ? (f.setName?.trim() ?? "") : "";
  return [String(f.year), brand, set].filter(Boolean).join(" ");
}

/** "1990 Topps, Baseball": the title and the sport. */
export function setLabel(f: { year: number; brand: string | null; setName: string | null; sport: Sport | null }): string {
  const name = setTitle(f);
  return f.sport ? `${name}, ${SPORT_LABELS[f.sport] ?? f.sport}` : name;
}

/**
 * The number used to match a card to the checklist: the catalog matching's
 * cleanCardNumber ("#0336" gives "336"), else the printed form. Null when blank.
 */
export function numberKeyOf(raw: string | null | undefined): string | null {
  const clean = cleanCardNumber(raw);
  if (clean) return clean;
  const printed = printedCardNumber(raw ?? "");
  return printed ? printed.slice(0, 30) : null;
}

/** Number order: the digits as a number, then letters before and after ("1", "2", "10", "10A", "U1"). */
export function compareNumbers(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const pa = /^([A-Z-]*?)(\d+)(.*)$/.exec(a);
  const pb = /^([A-Z-]*?)(\d+)(.*)$/.exec(b);
  if (pa && pb) {
    if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
    const d = Number(pa[2]) - Number(pb[2]);
    if (d !== 0) return d;
    return pa[3] < pb[3] ? -1 : pa[3] > pb[3] ? 1 : 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? -1 : 1;
}
