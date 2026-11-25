import type { Item } from "@/db/schema";
import { CONDITION_LABELS } from "@/lib/items/labels";
import { splitSerial } from "@/lib/items/serial";
import { findPricedCard } from "./key-prices";
import { listedTier } from "./players";
import {
  AUTO_AND_MEMORABILIA_MULTIPLIER, AUTOGRAPH_RANGES, AUTOGRAPH_SERIAL_MULTIPLIER, BULK_FROM_YEAR, BULK_PER_CARD,
  CONDITION_DISCOUNT, ERAS, ERROR_MULTIPLIER, GRADE_BANDS, INSERT_MULTIPLIER, MEMORABILIA_RANGES, PARALLEL_MULTIPLIER,
  PLAYER_TIER_WORDS, PLAYER_TIERS, PRODUCTS, ROOKIE_MULTIPLIER, SEALED_BRANDS, SEALED_EXCEPTIONS, SEALED_RANGES,
  SEALED_YEARS, SERIAL_TIERS, type PlayerTier, type Range,
} from "./tables";

/**
 * The built-in price guide: a pure function of the item's own fields.
 * No outside calls, no AI. The only outside fact it takes is whether the
 * stored Wikidata player facts say Hall of Fame, passed in by the caller.
 * Every answer is a rough range with a trust label of "Low" or "Very rough".
 */

export type GuideFields = Pick<Item,
  | "kind" | "year" | "yearEnd" | "sport" | "brand" | "setName" | "cardNumber" | "player" | "variation"
  | "isRookie" | "isError" | "isParallel" | "isInsert" | "isAutograph" | "isMemorabilia"
  | "serialNumber" | "serialEdition" | "rarityTier" | "condition" | "grader" | "grade"
  | "productType" | "estCount"
>;

export type GuideFacts = {
  /** From the stored Wikidata facts: true, false, or null when not known. */
  hallOfFame?: boolean | null;
};

export type GuideTrust = "Low" | "Very rough";

export type GuidePrice =
  | {
    ok: true;
    lowCents: number;
    highCents: number;
    /** The figure used for totals: the middle of the range on a ratio scale. */
    valueCents: number;
    /** "key_card", a player tier, "sealed" or "bulk". */
    tier: PlayerTier | "key_card" | "sealed" | "bulk";
    trust: GuideTrust;
    /** The rule that applied, in plain words, e.g. "Known key card: 1989 Upper Deck #1." */
    reason: string;
    /** The sentence kept in valueBasis. */
    basis: string;
  }
  | { ok: false; missing: string };

export const GUIDE_MISSING = {
  year: "No guide price yet: add the year.",
  playerOrNumber: "No guide price yet: add the player or the card number.",
  sealed: "No guide price for this sealed product: prices for it vary too much. Check real sales below.",
  bulkCount: "No guide price yet: add about how many cards are in the lot.",
  bulkOld: "No guide price for older loose cards: they vary too much. Check real sales below.",
} as const;

const NOTE = "A rough guide from built-in tables, not real sales.";

const tierRank = (t: PlayerTier) => PLAYER_TIERS.indexOf(t);
const higher = (a: PlayerTier, b: PlayerTier) => (tierRank(a) >= tierRank(b) ? a : b);
const scale = (r: Range, m: number): Range => [r[0] * m, r[1] * m];
const atLeast = (r: Range, floor: Range): Range => [Math.max(r[0], floor[0]), Math.max(r[1], floor[1])];

/** The player's tier from the built-in list, the stored Hall of Fame fact and the card's own rarity mark. */
export function playerTier(item: Pick<GuideFields, "player" | "sport" | "rarityTier"> & { year?: number | null }, facts: GuideFacts = {}): PlayerTier {
  let tier: PlayerTier = "common";
  const listed = listedTier(item.player, item.sport, item.year);
  if (listed) tier = higher(tier, listed);
  if (facts.hallOfFame === true) tier = higher(tier, "hof");
  if (item.rarityTier === "minor_star") tier = higher(tier, "minor_star");
  if (item.rarityTier === "star" || item.rarityTier === "key") tier = higher(tier, "star");
  if (item.rarityTier === "grail") tier = higher(tier, "hof");
  return tier;
}

/** The print run of a numbered card ("045/100" gives 100), or null. */
export function printRun(item: Pick<GuideFields, "serialEdition" | "serialNumber">): number | null {
  const edition = item.serialEdition ?? splitSerial(item.serialNumber)?.edition ?? null;
  const n = edition ? Number.parseInt(edition, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The numeric grade ("9.5", "PSA 10", "Gem Mint 10"), or null when there is none. */
export function numericGrade(grade: string | null | undefined): number | null {
  const m = /(\d{1,2}(?:\.\d)?)/.exec(grade ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

/**
 * The highest guide figure: 25,000 dollars. Above it the tables only
 * multiply guesses (a graded one of one of a great reached millions), so the
 * range stops here and says to check real sales.
 */
export const GUIDE_CEILING_CENTS = 2_500_000;
export const TOO_RARE = "Too rare for a guide price. Check real sales.";

function finish(range: Range, tier: Exclude<GuidePrice, { ok: false }>["tier"], trust: GuideTrust, reason: string): GuidePrice {
  if (range[1] > GUIDE_CEILING_CENTS) {
    range = [Math.min(range[0], GUIDE_CEILING_CENTS), GUIDE_CEILING_CENTS];
    trust = "Very rough";
    reason = `${TOO_RARE} ${reason}`;
  }
  const low = Math.max(1, Math.round(range[0]));
  const high = Math.max(low, Math.round(range[1]));
  const valueCents = Math.min(high, Math.max(low, Math.round(Math.sqrt(low * high))));
  return { ok: true, lowCents: low, highCents: high, valueCents, tier, trust, reason, basis: `Trust: ${trust}. ${reason} ${NOTE}` };
}

function cardGuide(item: GuideFields, facts: GuideFacts): GuidePrice {
  const year = item.year;
  if (year == null) return { ok: false, missing: GUIDE_MISSING.year };
  if (!item.player?.trim() && !item.cardNumber?.trim()) return { ok: false, missing: GUIDE_MISSING.playerOrNumber };

  const tier = playerTier(item, facts);
  const run = printRun(item);
  const special = item.isAutograph || item.isMemorabilia || run != null || item.isParallel || item.isInsert;
  const words: string[] = [];
  let veryRough = false;
  let range: Range;
  let guideTier: PlayerTier | "key_card" = tier;

  const key = special ? null : findPricedCard({
    sport: item.sport, year, brand: item.brand, setName: item.setName, cardNumber: item.cardNumber,
    player: item.player, isError: item.isError,
  });
  if (key) {
    range = [key.lowCents, key.highCents];
    guideTier = "key_card";
    words.push(`Known key card: ${key.year} ${key.setName} #${key.cardNumber}${key.isError ? " (error version)" : ""}.`);
  } else {
    const era = ERAS.find((e) => year >= e.from && year <= e.to) ?? ERAS[ERAS.length - 1];
    range = era.base[tier];
    const kind = item.isRookie ? "rookie card" : special || item.isError ? "card" : "base card";
    words.push(tier === "common"
      ? `${item.isRookie ? "Common rookie card" : "Common card"} from ${year}, ${era.words}.`
      : `${PLAYER_TIER_WORDS[tier]}, ${kind} from ${year}, ${era.words}.`);
    if (!item.player?.trim()) { words.push("No player named, so priced as a common card."); veryRough = true; }
    if (year < 1970) veryRough = true;
    if (item.isRookie) range = scale(range, ROOKIE_MULTIPLIER[tier]);

    const text = [item.brand, item.setName, item.variation].filter(Boolean).join(" ").toLowerCase().replace(/-/g, " ");
    const product = PRODUCTS.find((p) => p.match.test(text) && (!p.years || (year >= p.years[0] && year <= p.years[1])));
    if (product) { range = scale(range, product.multiplier); words.push(`Priced up for ${product.words}.`); }
    const glossy = product?.multiplier === 5;
    if (item.isParallel && !glossy) { range = scale(range, PARALLEL_MULTIPLIER); words.push("Parallel version."); veryRough = true; }
    if (item.isInsert) { range = scale(range, INSERT_MULTIPLIER); words.push("Insert card."); veryRough = true; }
    if (item.isError) { range = scale(range, ERROR_MULTIPLIER); words.push("Marked as an error; most errors add little."); veryRough = true; }

    if (item.isAutograph || item.isMemorabilia) {
      veryRough = true;
      if (item.isAutograph) {
        range = atLeast(range, AUTOGRAPH_RANGES[tier]);
        const boost = run != null ? AUTOGRAPH_SERIAL_MULTIPLIER.find((s) => run <= s.upTo)?.multiplier ?? 1 : 1;
        range = scale(range, boost * (item.isMemorabilia ? AUTO_AND_MEMORABILIA_MULTIPLIER : 1));
        words.push(item.isMemorabilia ? "Autograph with a memorabilia piece." : "Autograph.");
        if (run != null) words.push(`Numbered to ${run}.`);
      } else {
        range = atLeast(range, MEMORABILIA_RANGES[tier]);
        words.push("Has a memorabilia piece.");
      }
    }
    if (run != null && !item.isAutograph) {
      const s = SERIAL_TIERS.find((t) => run <= t.upTo) ?? SERIAL_TIERS[SERIAL_TIERS.length - 1];
      range = atLeast(scale(range, s.multiplier), s.floor);
      words.push(`Serial numbered: ${s.words}.`);
      veryRough = true;
    }
  }

  const grade = item.grader?.trim() ? numericGrade(item.grade) : null;
  if (grade != null) {
    const band = GRADE_BANDS.find((b) => grade >= b.from) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
    range = atLeast([range[0] * band.low, range[1] * band.high], band.floor);
    words.push(`Graded ${item.grader!.trim().toUpperCase()} ${item.grade!.trim()}, ${band.words}; graded prices swing a lot.`);
    veryRough = true;
  } else if (item.grader?.trim()) {
    words.push("Graded, but the grade is not a number, so priced as raw.");
    veryRough = true;
  } else if (item.condition && CONDITION_DISCOUNT[item.condition] < 1) {
    range = scale(range, CONDITION_DISCOUNT[item.condition]);
    words.push(`Condition ${CONDITION_LABELS[item.condition].toLowerCase()}, so priced lower.`);
  }

  return finish(range, guideTier, veryRough ? "Very rough" : "Low", words.join(" "));
}

function sealedGuide(item: GuideFields): GuidePrice {
  const year = item.year;
  if (year == null) return { ok: false, missing: GUIDE_MISSING.year };
  const brand = item.brand?.trim() ?? "";
  const range = SEALED_RANGES[item.productType ?? "other"];
  const exception = SEALED_EXCEPTIONS.some((e) => e.year === year && e.brand.test(`${brand} ${item.setName ?? ""}`) && (!e.sport || !item.sport || e.sport === item.sport));
  if (!range || year < SEALED_YEARS[0] || year > SEALED_YEARS[1] || !SEALED_BRANDS.test(brand) || exception) {
    return { ok: false, missing: GUIDE_MISSING.sealed };
  }
  return finish(range, "sealed", "Very rough", `Sealed ${brand} product from ${year}, a year with very large print runs.`);
}

function bulkGuide(item: GuideFields): GuidePrice {
  const year = item.year ?? item.yearEnd;
  if (year == null) return { ok: false, missing: GUIDE_MISSING.year };
  if (year < BULK_FROM_YEAR) return { ok: false, missing: GUIDE_MISSING.bulkOld };
  const count = item.estCount ?? 0;
  if (count < 1) return { ok: false, missing: GUIDE_MISSING.bulkCount };
  return finish(scale(BULK_PER_CARD, count), "bulk", "Very rough",
    `About ${count.toLocaleString("en-US")} loose cards from ${year} on; bulk commons sell for about a penny each.`);
}

/** The guide price for one unit of an item, or a plain line saying what is missing. */
export function guidePrice(item: GuideFields, facts: GuideFacts = {}): GuidePrice {
  if (item.kind === "sealed") return sealedGuide(item);
  if (item.kind === "bulk") return bulkGuide(item);
  return cardGuide(item, facts);
}
