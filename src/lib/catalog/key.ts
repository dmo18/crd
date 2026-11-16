import { SPORTS, type Sport } from "@/db/schema";
import { normalizeBrand, normalizeCardNumber, normalizeName, normalizeText } from "./normalize";

/** The facts a catalog key is built from. */
export type KeyParts = {
  sport: Sport | string | null | undefined;
  year: number | null | undefined;
  brand: string | null | undefined;
  setName?: string | null;
  cardNumber?: string | null;
  player: string | null | undefined;
  variation?: string | null;
};

/** The version of the key layout. A later milestone can rebuild keys that start with it. */
export const KEY_VERSION = "v1";

/** "Base Set", "Base" or nothing all mean the main set. */
function setPart(setName: string | null | undefined): string {
  const set = normalizeText(setName ?? "");
  return set === "" || set === "base set" || set === "base" ? "base" : set;
}

/**
 * The one place a catalog key is built: `v1|sport|year|brand|set|number|player`,
 * plus the variation as a last part only when there is one. Two spellings of
 * the same card give the same key. Returns null when sport, year, brand or
 * player is missing: such a record stays a plain item without a catalog link.
 */
export function canonicalKey(p: KeyParts): string | null {
  const sport = String(p.sport ?? "").trim().toLowerCase();
  if (!(SPORTS as readonly string[]).includes(sport)) return null;
  if (typeof p.year !== "number" || !Number.isInteger(p.year) || p.year < 1860 || p.year > 2100) return null;
  const brand = normalizeBrand(p.brand ?? "");
  const player = normalizeName(p.player ?? "");
  if (!brand || !player) return null;
  const parts = [KEY_VERSION, sport, String(p.year), brand, setPart(p.setName), normalizeCardNumber(p.cardNumber ?? ""), player];
  const variation = normalizeText(p.variation ?? "");
  if (variation) parts.push(variation);
  return parts.join("|");
}
