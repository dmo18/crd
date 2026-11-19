import type { Condition, ProductType } from "@/db/schema";

/**
 * The built-in price guide's rule tables.
 *
 * Written in late 2026 from general hobby knowledge, not from sales data.
 * Every figure is a WIDE rough range in whole US cents for ONE raw card in
 * clean (near mint) shape. A wide honest range beats a precise wrong one.
 * The rules in ./index.ts combine these tables; nothing here calls out.
 */

/** [low, high] in whole US cents. */
export type Range = readonly [number, number];

/**
 * How important the player is, weakest first.
 * common: no sign of a star; minor_star and star come from the card's own
 * rarity mark; hof: Hall of Fame (Wikidata or the built-in list);
 * great: one of the all-time greats whose every card sells.
 */
export const PLAYER_TIERS = ["common", "minor_star", "star", "hof", "great"] as const;
export type PlayerTier = (typeof PLAYER_TIERS)[number];

export const PLAYER_TIER_WORDS: Record<PlayerTier, string> = {
  common: "Common card",
  minor_star: "Card of a minor star",
  star: "Card of a star player",
  hof: "Hall of Fame player",
  great: "All-time great player",
};

export type Era = {
  /** First and last year, both included. */
  from: number;
  to: number;
  /** Plain words for the reason line, e.g. "a year with very large print runs". */
  words: string;
  /** Base card ranges by player tier. Must rise with the tier. */
  base: Record<PlayerTier, Range>;
};

/**
 * Base cards by era. The owner's collection is mostly 1980 to 1995.
 * - 1986 to 1994 was overproduced ("junk wax"): commons sell for a few cents
 *   and even Hall of Famers' base cards rarely pass a few dollars.
 * - Early 1980s and late 1990s print runs were smaller: a little more.
 * - Before 1980 cards are scarcer and older, so even commons are worth
 *   something; the older the decade, the more.
 * - Modern base (2015 on) commons are near worthless, stars sell.
 */
export const ERAS: readonly Era[] = [
  {
    from: 1900, to: 1959, words: "an early year when far fewer cards survived",
    base: { common: [300, 2500], minor_star: [800, 5000], star: [2000, 15000], hof: [5000, 50000], great: [20000, 300000] },
  },
  {
    from: 1960, to: 1969, words: "the 1960s, when fewer cards survived in good shape",
    base: { common: [100, 1000], minor_star: [300, 2500], star: [800, 6000], hof: [2000, 20000], great: [8000, 100000] },
  },
  {
    from: 1970, to: 1979, words: "the 1970s, before the big print runs",
    base: { common: [25, 300], minor_star: [75, 800], star: [200, 2000], hof: [500, 5000], great: [1500, 15000] },
  },
  {
    from: 1980, to: 1985, words: "the early 1980s, before the biggest print runs",
    base: { common: [5, 50], minor_star: [10, 100], star: [25, 300], hof: [50, 600], great: [100, 1500] },
  },
  {
    from: 1986, to: 1994, words: "a year with very large print runs",
    base: { common: [1, 25], minor_star: [5, 50], star: [10, 100], hof: [25, 300], great: [50, 800] },
  },
  {
    from: 1995, to: 1999, words: "the late 1990s, when print runs got smaller",
    base: { common: [5, 50], minor_star: [10, 100], star: [25, 300], hof: [50, 500], great: [100, 1500] },
  },
  {
    from: 2000, to: 2014, words: "a year of the 2000s",
    base: { common: [5, 50], minor_star: [10, 100], star: [25, 300], hof: [50, 600], great: [100, 1500] },
  },
  {
    from: 2015, to: 2100, words: "a recent year",
    base: { common: [10, 50], minor_star: [15, 100], star: [50, 400], hof: [100, 1000], great: [200, 2000] },
  },
];

/**
 * Rookie cards sell for more than later cards of the same player, and the
 * gap grows with the player: a common player's rookie card is still cheap.
 */
export const ROOKIE_MULTIPLIER: Record<PlayerTier, number> = {
  common: 2, minor_star: 3, star: 4, hof: 5, great: 5,
};

/**
 * Better made or smaller print products, matched as words in the brand, set
 * or version. The highest single match is used, never several at once.
 * Base Topps, Donruss, Fleer and Score stay at 1.
 */
export const PRODUCTS: readonly { match: RegExp; multiplier: number; words: string; years?: [number, number] }[] = [
  { match: /\btiffany\b/, multiplier: 5, words: "Topps Tiffany, a small glossy print run" },
  { match: /\brefractor\b/, multiplier: 5, words: "a refractor" },
  { match: /\bfinest\b/, multiplier: 3, words: "a Finest card" },
  { match: /\bbowman'?s best\b/, multiplier: 2, words: "a Bowman's Best card" },
  { match: /\bchrome\b/, multiplier: 2, words: "a Chrome card" },
  { match: /\bprizm\b/, multiplier: 2, words: "a Prizm card" },
  { match: /(^|\s)sp(\s|$)|\bupper deck sp\b/, multiplier: 2, words: "an SP foil card" },
  { match: /\bupper deck\b/, multiplier: 2, words: "the first Upper Deck set", years: [1989, 1989] },
  { match: /\bleaf\b/, multiplier: 2, words: "1990 Leaf, a small premium set", years: [1990, 1990] },
  { match: /\bstadium club\b/, multiplier: 1.5, words: "a Stadium Club card" },
  { match: /\bselect\b|\bflair\b/, multiplier: 1.5, words: "a premium set" },
  { match: /\bo ?pee ?chee\b|\bopc\b/, multiplier: 1.5, words: "O-Pee-Chee, a smaller print run than Topps", years: [1900, 1989] },
  { match: /\bupper deck\b|\bultra\b/, multiplier: 1.2, words: "a better made set" },
];

/** A parallel (another color or finish) without a serial number. */
export const PARALLEL_MULTIPLIER = 3;
/** An insert (a special subset card) without a serial number. */
export const INSERT_MULTIPLIER = 3;
/** An error that is not in the known card list: most add little. */
export const ERROR_MULTIPLIER = 1.5;

/**
 * Serial numbered cards by print run. The range is the base range times the
 * multiplier, but never below the floor: a numbered card of anyone sells.
 * Checked top to bottom; the first row whose `upTo` is at or above the print run wins.
 */
export const SERIAL_TIERS: readonly { upTo: number; multiplier: number; floor: Range; words: string }[] = [
  { upTo: 1, multiplier: 100, floor: [5000, 100000], words: "a 1 of 1" },
  { upTo: 5, multiplier: 40, floor: [2000, 25000], words: "numbered to 5 or fewer" },
  { upTo: 10, multiplier: 25, floor: [1000, 10000], words: "numbered to 10 or fewer" },
  { upTo: 25, multiplier: 15, floor: [500, 5000], words: "numbered to 25 or fewer" },
  { upTo: 50, multiplier: 10, floor: [300, 3000], words: "numbered to 50 or fewer" },
  { upTo: 99, multiplier: 8, floor: [250, 2000], words: "numbered to 99 or fewer" },
  { upTo: 250, multiplier: 5, floor: [200, 1500], words: "numbered to 250 or fewer" },
  { upTo: 500, multiplier: 3, floor: [100, 800], words: "numbered to 500 or fewer" },
  { upTo: 1000, multiplier: 2, floor: [50, 500], words: "numbered to 1000 or fewer" },
  { upTo: Number.POSITIVE_INFINITY, multiplier: 1.5, floor: [25, 300], words: "numbered to more than 1000" },
];

/**
 * Autographs: priced by the player, not the base card. These replace the
 * base range (the base range is used only when it is higher).
 */
export const AUTOGRAPH_RANGES: Record<PlayerTier, Range> = {
  common: [300, 2000], minor_star: [500, 4000], star: [1500, 10000], hof: [3000, 30000], great: [10000, 100000],
};

/** Game used memorabilia (jersey or bat pieces): floors by player. */
export const MEMORABILIA_RANGES: Record<PlayerTier, Range> = {
  common: [200, 1500], minor_star: [300, 2500], star: [800, 5000], hof: [1500, 10000], great: [3000, 25000],
};

/** An autograph that also has a memorabilia piece. */
export const AUTO_AND_MEMORABILIA_MULTIPLIER = 1.5;

/** A small print run makes an autograph rarer still, but less than for a base card. */
export const AUTOGRAPH_SERIAL_MULTIPLIER: readonly { upTo: number; multiplier: number }[] = [
  { upTo: 1, multiplier: 5 },
  { upTo: 10, multiplier: 3 },
  { upTo: 25, multiplier: 2 },
  { upTo: 99, multiplier: 1.5 },
];

/**
 * Graded cards by grade band, applied to the raw range: [low, high]
 * multipliers, so the range widens because top grades swing so much.
 * The floor is about what a slab costs: almost no graded card sells for less.
 * Checked top to bottom; the first band whose `from` is at or below the grade wins.
 */
export const GRADE_BANDS: readonly { from: number; low: number; high: number; floor: Range; words: string }[] = [
  { from: 10, low: 5, high: 20, floor: [800, 2500], words: "a perfect 10" },
  { from: 9.5, low: 3, high: 8, floor: [800, 2000], words: "a 9.5" },
  { from: 9, low: 1.5, high: 4, floor: [500, 1500], words: "a 9" },
  { from: 8, low: 1, high: 2, floor: [400, 1200], words: "an 8" },
  { from: 7, low: 0.7, high: 1.3, floor: [300, 1000], words: "a 7" },
  { from: 5, low: 0.4, high: 0.9, floor: [300, 800], words: "a middle grade" },
  { from: 0, low: 0.2, high: 0.6, floor: [200, 600], words: "a low grade" },
];

/**
 * Raw cards below near mint sell for less. Mint and gem mint stay at 1: a
 * raw card has not been checked by a grader, so buyers pay near mint at most.
 */
export const CONDITION_DISCOUNT: Record<Condition, number> = {
  poor: 0.08, fair: 0.12, good: 0.2, very_good: 0.3, excellent: 0.5, near_mint: 1, mint: 1, gem_mint: 1,
};

/**
 * Sealed product, only for 1987 to 1994 base brands where boxes are plentiful.
 * Other sealed product swings too much for a table (some boxes sell for
 * thousands), so the guide gives no figure for it.
 */
export const SEALED_YEARS: readonly [number, number] = [1987, 1994];
export const SEALED_BRANDS = /^(topps|donruss|fleer|score|pro set|upper deck|bowman|o-pee-chee|nba hoops|hoops)$/i;
/** Sets from those years known to sell far above the rest when sealed. */
export const SEALED_EXCEPTIONS: readonly { year: number; brand: RegExp; sport?: string }[] = [
  { year: 1989, brand: /upper deck/i, sport: "baseball" },
  { year: 1989, brand: /score/i, sport: "football" },
  { year: 1989, brand: /hoops/i },
  { year: 1990, brand: /upper deck/i, sport: "hockey" },
  { year: 1992, brand: /bowman/i },
  { year: 1993, brand: /upper deck|sp/i, sport: "baseball" },
];
export const SEALED_RANGES: Record<ProductType, Range | null> = {
  pack: [50, 500],
  cello_pack: [100, 800],
  rack_pack: [100, 800],
  blister: [200, 1500],
  box: [800, 6000],
  case: [8000, 60000],
  factory_set: [1000, 6000],
  other: null,
};

/** Loose bulk cards from 1980 on, per card: half a cent to two cents. */
export const BULK_PER_CARD: Range = [0.5, 2];
export const BULK_FROM_YEAR = 1980;
