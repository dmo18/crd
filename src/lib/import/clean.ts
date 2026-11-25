import {
  CONDITIONS, ITEM_KINDS, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS,
  type Condition, type ItemKind, type ProductType, type RarityTier, type SealState, type Sport,
} from "@/db/schema";
import { CONDITION_LABELS, KIND_LABELS, PRODUCT_LABELS, RARITY_LABELS, SEAL_LABELS, SPORT_LABELS } from "@/lib/items/labels";
import { parseDollars } from "@/lib/money";
import { unguardCell } from "./csv";

/**
 * Value cleaning for imported cells. Every rule here is safe and stated on
 * the import screen: nothing is guessed beyond these.
 */

export const FIRST_YEAR = 1860;
/** The latest year a card can have: next year (new sets come out early). */
export const lastYear = (now: Date) => now.getUTCFullYear() + 1;

/** Cell text as it will be read: the export's formula guard taken off, spaces trimmed. */
export function cleanCell(raw: string | undefined): string {
  return unguardCell(raw ?? "").trim();
}

const YES = new Set(["yes", "y", "true", "x", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

/** "Yes", "Y", "true", "x" or "1" is yes; "No", "N", "false" or "0" is no; empty is null; anything else is "bad". */
export function yesNo(s: string): boolean | null | "bad" {
  const k = s.trim().toLowerCase();
  if (k === "") return null;
  if (YES.has(k)) return true;
  if (NO.has(k)) return false;
  return "bad";
}

/** "1993", or a season such as "1993-94", "1993/94" or "1993-1994", gives its first year. Null when it is not a year. */
export function cleanYear(s: string): number | null {
  const m = /^(\d{4})(?:\s*[-/]\s*(?:\d{2}|\d{4}))?$/.exec(s.trim());
  return m ? Number(m[1]) : null;
}

/** "$1,234.50" gives 123450 cents (src/lib/money.ts). Null when it is not a dollar amount. */
export function cleanMoney(s: string): number | null {
  return parseDollars(s);
}

/** Lowercase with spaces, underscores and dashes all the same, for matching words to a list. */
const wordKey = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s_\-]+/g, " ").trim();

function matcher<T extends string>(values: readonly T[], labels: Record<T, string>, extra: Record<string, T> = {}) {
  const map = new Map<string, T>();
  for (const v of values) {
    map.set(wordKey(v), v);
    map.set(wordKey(labels[v]), v);
  }
  for (const [k, v] of Object.entries(extra)) map.set(wordKey(k), v);
  return (s: string): T | null => map.get(wordKey(s)) ?? null;
}

/** Sport words, any capitals. */
export const matchSport = matcher<Sport>(SPORTS, SPORT_LABELS, { multi: "multi", "multi sport": "multi", "multiple": "multi" });
/** Condition words, any capitals, plus the usual short forms VG, EX, NM. */
export const matchCondition = matcher<Condition>(CONDITIONS, CONDITION_LABELS, { vg: "very_good", ex: "excellent", nm: "near_mint", gem: "gem_mint" });
export const matchKind = matcher<ItemKind>(ITEM_KINDS, KIND_LABELS, { sealed: "sealed", bulk: "bulk", lot: "bulk", "bulk lot": "bulk" });
export const matchRarity = matcher<RarityTier>(RARITY_TIERS, RARITY_LABELS, { key: "key" });
export const matchProduct = matcher<ProductType>(PRODUCT_TYPES, PRODUCT_LABELS);
export const matchSeal = matcher<SealState>(SEAL_STATES, SEAL_LABELS, { sealed: "factory_sealed" });

export const listOf = (labels: Record<string, string>) => Object.values(labels).join(", ");
