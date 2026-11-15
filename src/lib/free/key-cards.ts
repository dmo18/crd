import type { RarityTier, Sport } from "@/db/schema";

/**
 * A built-in list of notable cards from 1980 to 1995, used to flag key rookies,
 * famous errors and star rookies without any paid service.
 *
 * The facts come from general hobby knowledge. A card is listed only when the
 * year, brand, set and card number were all known with high confidence; cards
 * with any doubt about the number were left out on purpose.
 *
 * Coverage:
 * - Baseball: Topps, Topps Traded, Fleer, Fleer Update, Donruss, Donruss Rookies,
 *   Leaf, Bowman, Score Traded, Upper Deck and Upper Deck SP, 1980 to 1994.
 * - Basketball: Star, Fleer, Fleer Stickers, Fleer Ultra, NBA Hoops and Upper Deck,
 *   1984 to 1992 (year is the first year of the season, so 1986 means 1986 to 87).
 * - Football: Topps, Topps USFL, Topps Traded, Score, Score Supplemental and
 *   Stadium Club, 1981 to 1991.
 * - Hockey: O-Pee-Chee, Topps and Upper Deck, 1980 to 1990 (year is the first year
 *   of the season).
 *
 * Card numbers are written as printed: "98T" for Topps Traded, "U-27" for Fleer Update.
 * isRookie follows collector convention: 1986 Fleer basketball counts as the
 * rookie card even though Star Company cards came first. It is false when an
 * earlier card that collectors treat as the rookie exists, for example a USFL
 * football card or the 1985 Topps Olympic McGwire.
 * Left out for now because the card number was not certain: the 1980 Topps
 * basketball Bird, Erving and Magic panel.
 */

export type KeyCard = {
  sport: Sport;
  year: number;
  brand: string;
  setName: string;
  cardNumber: string;
  player: string;
  isRookie: boolean;
  isError: boolean;
  variation: string | null;
  tier: Extract<RarityTier, "star" | "key" | "grail">;
  note: string;
};

export type KeyCardQuery = {
  year?: number | null;
  brand?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  sport?: Sport | null;
};

type Tier = KeyCard["tier"];

type Opts = { error?: boolean; variation?: string; rookie?: boolean };

function card(
  sport: Sport,
  year: number,
  brand: string,
  setName: string,
  cardNumber: string,
  player: string,
  tier: Tier,
  note: string,
  opts: Opts = {},
): KeyCard {
  return {
    sport,
    year,
    brand,
    setName,
    cardNumber,
    player,
    isRookie: opts.rookie ?? true,
    isError: opts.error ?? false,
    variation: opts.variation ?? null,
    tier,
    note,
  };
}

const B: Sport = "baseball";
const K: Sport = "basketball";
const F: Sport = "football";
const H: Sport = "hockey";

export const KEY_CARDS: readonly KeyCard[] = [
  // Baseball
  card(B, 1980, "Topps", "Topps", "482", "Rickey Henderson", "key", "Rookie card of the career stolen base leader."),
  card(B, 1982, "Topps", "Topps", "21", "Cal Ripken Jr.", "key", "Rookie card shared with two other Orioles prospects."),
  card(B, 1982, "Topps", "Topps Traded", "98T", "Cal Ripken Jr.", "key", "His first solo Topps card, from the Traded set."),
  card(B, 1982, "Fleer", "Fleer", "176", "Cal Ripken Jr.", "key", "Rookie card from the 1982 Fleer set."),
  card(B, 1982, "Donruss", "Donruss", "405", "Cal Ripken Jr.", "key", "Rookie card from the 1982 Donruss set."),
  card(B, 1983, "Topps", "Topps", "482", "Tony Gwynn", "key", "Rookie card of the Padres hitting great."),
  card(B, 1983, "Topps", "Topps", "498", "Wade Boggs", "key", "Rookie card of the Red Sox hitting great."),
  card(B, 1983, "Fleer", "Fleer", "360", "Tony Gwynn", "key", "Rookie card from the 1983 Fleer set."),
  card(B, 1983, "Fleer", "Fleer", "179", "Wade Boggs", "key", "Rookie card from the 1983 Fleer set."),
  card(B, 1983, "Donruss", "Donruss", "598", "Tony Gwynn", "key", "Rookie card from the 1983 Donruss set."),
  card(B, 1983, "Donruss", "Donruss", "586", "Wade Boggs", "key", "Rookie card from the 1983 Donruss set."),
  card(B, 1983, "Topps", "Topps", "83", "Ryne Sandberg", "key", "Rookie card of the Cubs second baseman."),
  card(B, 1983, "Fleer", "Fleer", "507", "Ryne Sandberg", "key", "Rookie card from the 1983 Fleer set."),
  card(B, 1983, "Donruss", "Donruss", "277", "Ryne Sandberg", "key", "Rookie card from the 1983 Donruss set."),
  card(B, 1983, "Topps", "Topps Traded", "108T", "Darryl Strawberry", "star", "Rookie card from the 1983 Topps Traded set."),
  card(B, 1984, "Topps", "Topps", "8", "Don Mattingly", "key", "Rookie card of the Yankees first baseman."),
  card(B, 1984, "Fleer", "Fleer", "131", "Don Mattingly", "key", "Rookie card from the 1984 Fleer set."),
  card(B, 1984, "Donruss", "Donruss", "248", "Don Mattingly", "key", "Rookie card and one of the best known Donruss cards."),
  card(B, 1984, "Fleer", "Fleer Update", "U-27", "Roger Clemens", "key", "Early Clemens card from the hard to find Fleer Update set."),
  card(B, 1984, "Fleer", "Fleer Update", "U-93", "Kirby Puckett", "key", "Early Puckett card from the hard to find Fleer Update set."),
  card(B, 1984, "Topps", "Topps Traded", "42T", "Dwight Gooden", "star", "Rookie card from the 1984 Topps Traded set."),
  card(B, 1984, "Fleer", "Fleer Update", "U-43", "Dwight Gooden", "star", "Early Gooden card from the hard to find Fleer Update set."),
  card(B, 1985, "Topps", "Topps", "401", "Mark McGwire", "key", "First McGwire card, from the 1984 Olympic team subset."),
  card(B, 1985, "Topps", "Topps", "181", "Roger Clemens", "key", "Rookie card from the 1985 Topps set."),
  card(B, 1985, "Topps", "Topps", "536", "Kirby Puckett", "key", "Rookie card from the 1985 Topps set."),
  card(B, 1985, "Topps", "Topps", "620", "Dwight Gooden", "star", "Rookie card from the 1985 Topps set."),
  card(B, 1985, "Fleer", "Fleer", "155", "Roger Clemens", "key", "Rookie card from the 1985 Fleer set."),
  card(B, 1985, "Fleer", "Fleer", "286", "Kirby Puckett", "key", "Rookie card from the 1985 Fleer set."),
  card(B, 1985, "Donruss", "Donruss", "273", "Roger Clemens", "key", "Rookie card from the 1985 Donruss set."),
  card(B, 1985, "Donruss", "Donruss", "438", "Kirby Puckett", "key", "Rookie card from the 1985 Donruss set."),
  card(B, 1986, "Donruss", "Donruss", "39", "Jose Canseco", "key", "Rated Rookie card and a hobby favorite of the 1980s."),
  card(B, 1986, "Donruss", "Donruss Rookies", "22", "Jose Canseco", "star", "Rookie card from the boxed 1986 Donruss The Rookies set."),
  card(B, 1986, "Topps", "Topps Traded", "11T", "Barry Bonds", "key", "First Topps card of the career home run leader."),
  card(B, 1986, "Topps", "Topps Traded", "20T", "Jose Canseco", "star", "Rookie card from the 1986 Topps Traded set."),
  card(B, 1986, "Topps", "Topps Traded", "50T", "Bo Jackson", "star", "Rookie card from the 1986 Topps Traded set."),
  card(B, 1987, "Topps", "Topps", "320", "Barry Bonds", "key", "Rookie card from the 1987 Topps set."),
  card(B, 1987, "Topps", "Topps", "366", "Mark McGwire", "key", "First regular Topps card of McGwire with the A's; his 1985 Topps Olympic card came first.", { rookie: false }),
  card(B, 1987, "Topps", "Topps", "170", "Bo Jackson", "star", "Future Stars card from the 1987 Topps set."),
  card(B, 1987, "Fleer", "Fleer", "604", "Barry Bonds", "key", "Rookie card from the 1987 Fleer set."),
  card(B, 1987, "Fleer", "Fleer", "396", "Mark McGwire", "key", "Rookie card from the 1987 Fleer set."),
  card(B, 1987, "Donruss", "Donruss", "361", "Barry Bonds", "key", "Rookie card from the 1987 Donruss set."),
  card(B, 1987, "Donruss", "Donruss", "46", "Mark McGwire", "key", "Rated Rookie card from the 1987 Donruss set."),
  card(B, 1987, "Donruss", "Donruss", "35", "Bo Jackson", "star", "Rated Rookie card from the 1987 Donruss set."),
  card(B, 1987, "Donruss", "Donruss", "36", "Greg Maddux", "key", "Rated Rookie card of the four time Cy Young winner."),
  card(B, 1987, "Topps", "Topps Traded", "70T", "Greg Maddux", "key", "Rookie card from the 1987 Topps Traded set."),
  card(B, 1989, "Upper Deck", "Upper Deck", "1", "Ken Griffey Jr.", "grail", "Card number 1 of the first Upper Deck set and the best known card of the era."),
  card(B, 1989, "Upper Deck", "Upper Deck", "25", "Randy Johnson", "key", "Rookie card from the first Upper Deck set."),
  card(B, 1989, "Upper Deck", "Upper Deck", "17", "John Smoltz", "star", "Rookie card from the first Upper Deck set."),
  card(B, 1989, "Upper Deck", "Upper Deck", "13", "Gary Sheffield", "star", "Rookie card from the first Upper Deck set."),
  card(B, 1989, "Upper Deck", "Upper Deck", "357", "Dale Murphy", "key", "Early copies show the photo reversed; check the picture against later copies.", {
    rookie: false,
    error: true,
    variation: "Reverse negative",
  }),
  card(B, 1989, "Fleer", "Fleer", "548", "Ken Griffey Jr.", "key", "Rookie card from the 1989 Fleer set."),
  card(B, 1989, "Fleer", "Fleer", "616", "Bill Ripken", "key", "Famous error with a rude word on the bat knob; later copies were covered up.", {
    rookie: false,
    error: true,
    variation: "Obscenity on bat knob",
  }),
  card(B, 1989, "Donruss", "Donruss", "33", "Ken Griffey Jr.", "key", "Rated Rookie card from the 1989 Donruss set."),
  card(B, 1989, "Donruss", "Donruss", "42", "Randy Johnson", "star", "Rated Rookie card from the 1989 Donruss set."),
  card(B, 1989, "Bowman", "Bowman", "220", "Ken Griffey Jr.", "key", "Rookie card from the 1989 Bowman set."),
  card(B, 1989, "Topps", "Topps Traded", "41T", "Ken Griffey Jr.", "key", "Rookie card from the 1989 Topps Traded set."),
  card(B, 1989, "Score", "Score Traded", "100T", "Ken Griffey Jr.", "key", "Rookie card from the 1989 Score Rookie and Traded set."),
  card(B, 1990, "Topps", "Topps", "414", "Frank Thomas", "key", "Rookie card of the White Sox slugger."),
  card(B, 1990, "Topps", "Topps", "414", "Frank Thomas", "grail", "Rare error with no name on the front; check the bottom border.", {
    error: true,
    variation: "No name on front",
  }),
  card(B, 1990, "Leaf", "Leaf", "300", "Frank Thomas", "key", "Rookie card from the first modern Leaf set."),
  card(B, 1992, "Bowman", "Bowman", "302", "Mariano Rivera", "key", "Rookie card of the career saves leader."),
  card(B, 1993, "Topps", "Topps", "98", "Derek Jeter", "key", "Draft pick rookie card from the 1993 Topps set."),
  card(B, 1993, "Upper Deck", "Upper Deck", "449", "Derek Jeter", "key", "Rookie card from the 1993 Upper Deck set."),
  card(B, 1993, "Upper Deck", "SP", "279", "Derek Jeter", "grail", "Foil rookie card that is hard to find in clean condition."),
  card(B, 1994, "Upper Deck", "SP", "15", "Alex Rodriguez", "key", "Foil rookie card from the 1994 SP set."),

  // Basketball
  card(K, 1984, "Star", "Star", "101", "Michael Jordan", "key", "First Jordan card, sold only in team bags."),
  card(K, 1986, "Fleer", "Fleer", "57", "Michael Jordan", "grail", "The best known basketball card of the era. Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer Stickers", "8", "Michael Jordan", "key", "Sticker found one per 1986 Fleer pack. An insert, not a rookie card.", { rookie: false }),
  card(K, 1986, "Fleer", "Fleer", "7", "Charles Barkley", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "82", "Hakeem Olajuwon", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "32", "Patrick Ewing", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "68", "Karl Malone", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "26", "Clyde Drexler", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "121", "Dominique Wilkins", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "109", "Isiah Thomas", "key", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "131", "James Worthy", "star", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "27", "Joe Dumars", "star", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1986, "Fleer", "Fleer", "77", "Chris Mullin", "star", "Rookie card as collectors count it; an earlier Star Company card exists."),
  card(K, 1987, "Fleer", "Fleer", "59", "Michael Jordan", "key", "Second year Fleer card of Jordan.", { rookie: false }),
  card(K, 1988, "Fleer", "Fleer", "20", "Scottie Pippen", "key", "Rookie card from the 1988 Fleer set."),
  card(K, 1988, "Fleer", "Fleer", "57", "Reggie Miller", "star", "Rookie card from the 1988 Fleer set."),
  card(K, 1988, "Fleer", "Fleer", "43", "Dennis Rodman", "star", "Rookie card from the 1988 Fleer set."),
  card(K, 1989, "NBA Hoops", "NBA Hoops", "138", "David Robinson", "key", "Rookie card from the first NBA Hoops set."),
  card(K, 1992, "Upper Deck", "Upper Deck", "1", "Shaquille O'Neal", "key", "Draft pick rookie card that opens the 1992 Upper Deck set."),
  card(K, 1992, "Fleer", "Fleer", "401", "Shaquille O'Neal", "key", "Rookie card from the 1992 Fleer set."),
  card(K, 1992, "Fleer", "Fleer Ultra", "328", "Shaquille O'Neal", "key", "Rookie card from the 1992 Fleer Ultra set."),
  card(K, 1992, "NBA Hoops", "NBA Hoops", "442", "Shaquille O'Neal", "key", "Rookie card from the 1992 NBA Hoops set."),

  // Football
  card(F, 1981, "Topps", "Topps", "216", "Joe Montana", "grail", "Rookie card of the four time Super Bowl winning quarterback."),
  card(F, 1984, "Topps", "Topps", "63", "John Elway", "key", "Rookie card from the 1984 Topps set."),
  card(F, 1984, "Topps", "Topps", "123", "Dan Marino", "key", "Rookie card from the 1984 Topps set."),
  card(F, 1984, "Topps", "Topps USFL", "36", "Jim Kelly", "key", "First Kelly card, from his USFL days."),
  card(F, 1984, "Topps", "Topps USFL", "52", "Steve Young", "key", "First Young card, from his USFL days."),
  card(F, 1984, "Topps", "Topps USFL", "58", "Reggie White", "key", "First White card, from his USFL days."),
  card(F, 1986, "Topps", "Topps", "161", "Jerry Rice", "key", "Rookie card of the career receiving leader."),
  card(F, 1986, "Topps", "Topps", "374", "Steve Young", "star", "First NFL card of Young; his 1984 USFL card came first.", { rookie: false }),
  card(F, 1986, "Topps", "Topps", "275", "Reggie White", "star", "First NFL card of White; his 1984 USFL card came first.", { rookie: false }),
  card(F, 1987, "Topps", "Topps", "362", "Jim Kelly", "star", "First NFL card of Kelly; his 1984 USFL card came first.", { rookie: false }),
  card(F, 1988, "Topps", "Topps", "327", "Bo Jackson", "key", "Football rookie card of the two sport star."),
  card(F, 1989, "Score", "Score", "257", "Barry Sanders", "key", "Rookie card from the first Score football set."),
  card(F, 1989, "Score", "Score", "270", "Troy Aikman", "key", "Rookie card from the first Score football set."),
  card(F, 1989, "Score", "Score", "246", "Deion Sanders", "key", "Rookie card from the first Score football set."),
  card(F, 1989, "Topps", "Topps Traded", "83T", "Barry Sanders", "key", "Rookie card from the 1989 Topps Traded set."),
  card(F, 1990, "Score", "Score Supplemental", "101T", "Emmitt Smith", "key", "Rookie card from the 1990 Score Supplemental set."),
  card(F, 1990, "Topps", "Topps Traded", "27T", "Emmitt Smith", "key", "Rookie card from the 1990 Topps Traded set."),
  card(F, 1991, "Topps", "Stadium Club", "94", "Brett Favre", "key", "Rookie card from the first Stadium Club football set."),

  // Hockey
  card(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "140", "Ray Bourque", "key", "Rookie card from the 1980 O-Pee-Chee set."),
  card(H, 1980, "Topps", "Topps", "140", "Ray Bourque", "star", "Rookie card from the 1980 Topps set."),
  card(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "289", "Mark Messier", "key", "Rookie card found only in O-Pee-Chee."),
  card(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "250", "Wayne Gretzky", "key", "Second year card of Gretzky.", { rookie: false }),
  card(H, 1984, "O-Pee-Chee", "O-Pee-Chee", "67", "Steve Yzerman", "key", "Rookie card from the 1984 O-Pee-Chee set."),
  card(H, 1984, "Topps", "Topps", "49", "Steve Yzerman", "star", "Rookie card from the 1984 Topps set."),
  card(H, 1985, "O-Pee-Chee", "O-Pee-Chee", "9", "Mario Lemieux", "grail", "The best known hockey rookie card of the era."),
  card(H, 1985, "Topps", "Topps", "9", "Mario Lemieux", "key", "Rookie card from the 1985 Topps set."),
  card(H, 1986, "O-Pee-Chee", "O-Pee-Chee", "53", "Patrick Roy", "key", "Rookie card from the 1986 O-Pee-Chee set."),
  card(H, 1986, "Topps", "Topps", "53", "Patrick Roy", "star", "Rookie card from the 1986 Topps set."),
  card(H, 1988, "O-Pee-Chee", "O-Pee-Chee", "66", "Brett Hull", "key", "Rookie card from the 1988 O-Pee-Chee set."),
  card(H, 1990, "Upper Deck", "Upper Deck", "356", "Jaromir Jagr", "star", "Rookie card from the first Upper Deck hockey set."),
];

/** Case and punctuation insensitive brand key: "O-Pee-Chee" and "o pee chee" both give "opeechee". */
export function normalizeBrand(s: string): string {
  return stripAccents(String(s ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Lowercase, accents stripped, punctuation removed: "Ken Griffey Jr." gives "ken griffey jr". */
export function normalizeName(s: string): string {
  return stripAccents(String(s ?? ""))
    .toLowerCase()
    .replace(/['\u2019.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Card number key: "U-27", "u27" and "27U" all match, leading zeros ignored. */
export function normalizeCardNumber(s: string): string {
  const up = String(s ?? "").toUpperCase();
  const letters = up.replace(/[^A-Z]/g, "");
  const digits = up.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
  return letters + digits;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function sameText(a: string, b: string): boolean {
  return normalizeBrand(a) === normalizeBrand(b);
}

/** One answer from several matches, or null when they disagree. */
function pickOne(matches: KeyCard[]): KeyCard | null {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  const first = matches[0];
  const sameCard = matches.every(
    (m) => m.setName === first.setName && m.cardNumber === first.cardNumber && normalizeName(m.player) === normalizeName(first.player),
  );
  if (!sameCard) return null;
  // The plain card and its error or variation: the plain one is the safe answer.
  const plain = matches.filter((m) => m.variation == null);
  return plain.length === 1 ? plain[0] : null;
}

/**
 * Finds one listed card. Needs a year and a brand, then the card number,
 * or when no number was read the player. Returns null on no match or a tie.
 * This is a plain lookup: use matchKeyCard to check what was read against it.
 */
export function findKeyCard(q: KeyCardQuery): KeyCard | null {
  try {
    if (q.year == null || !q.brand) return null;
    const brand = normalizeBrand(q.brand);
    if (!brand) return null;
    let pool = KEY_CARDS.filter((k) => k.year === q.year && normalizeBrand(k.brand) === brand);
    if (q.sport) pool = pool.filter((k) => k.sport === q.sport);
    if (q.setName) pool = pool.filter((k) => sameText(k.setName, q.setName as string));
    if (pool.length === 0) return null;

    if (q.cardNumber) {
      const num = normalizeCardNumber(q.cardNumber);
      if (num) {
        const byNumber = pool.filter((k) => normalizeCardNumber(k.cardNumber) === num);
        // A number that is not listed rules out a match by name: it is a different card of that player.
        return byNumber.length > 0 ? pickOne(byNumber) : null;
      }
    }
    if (q.player) {
      const name = normalizeName(q.player);
      if (name) {
        const byName = pool.filter((k) => normalizeName(k.player) === name);
        if (byName.length > 0) return pickOne(byName);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type KeyCardRead = {
  year: number | null;
  brand: string | null;
  setName?: string | null;
  cardNumber: string | null;
  /** Every name read from the card, best first. */
  players: string[];
  sport: Sport | null;
};

export type KeyCardMatch = {
  card: KeyCard;
  /**
   * confirmed: year, brand, number and player all agree.
   * possible: only the number or only the player agrees, so the owner checks it.
   */
  how: "confirmed" | "possible";
  /** A listed error or variation of this card: the owner checks which version it is. */
  errorCheck: KeyCard | null;
};

function errorVersionOf(card: KeyCard): KeyCard | null {
  if (card.isError) return card;
  return (
    KEY_CARDS.find(
      (k) =>
        k !== card &&
        k.isError &&
        k.year === card.year &&
        k.setName === card.setName &&
        k.cardNumber === card.cardNumber &&
        normalizeName(k.player) === normalizeName(card.player),
    ) ?? null
  );
}

/**
 * Matches what was read against the list without trusting any one clue:
 * - number and player both agree: confirmed;
 * - number agrees and no player was read: possible;
 * - a player was read and differs: no match, even when the number agrees;
 * - player agrees and no number was read: possible; a different number read: no match;
 * - a sport read from the card that differs from the listed card: no match.
 */
export function matchKeyCard(r: KeyCardRead): KeyCardMatch | null {
  try {
    if (r.year == null || !r.brand) return null;
    const brand = normalizeBrand(r.brand);
    if (!brand) return null;
    let pool = KEY_CARDS.filter((k) => k.year === r.year && normalizeBrand(k.brand) === brand);
    if (r.sport) pool = pool.filter((k) => k.sport === r.sport);
    // A set name that is just the brand was not really read, so it does not narrow the list.
    if (r.setName && normalizeBrand(r.setName) !== brand) pool = pool.filter((k) => sameText(k.setName, r.setName as string));
    if (pool.length === 0) return null;
    const names = new Set(r.players.map(normalizeName).filter(Boolean));
    const done = (card: KeyCard | null, how: KeyCardMatch["how"]): KeyCardMatch | null =>
      card ? { card, how, errorCheck: errorVersionOf(card) } : null;

    const num = r.cardNumber ? normalizeCardNumber(r.cardNumber) : "";
    if (num) {
      const byNumber = pool.filter((k) => normalizeCardNumber(k.cardNumber) === num);
      if (byNumber.length === 0) return null;
      if (names.size === 0) return done(pickOne(byNumber), "possible");
      const agree = byNumber.filter((k) => names.has(normalizeName(k.player)));
      return agree.length > 0 ? done(pickOne(agree), "confirmed") : null;
    }
    const byName = pool.filter((k) => names.has(normalizeName(k.player)));
    return byName.length > 0 ? done(pickOne(byName), "possible") : null;
  } catch {
    return null;
  }
}

const TIER_ORDER: Record<Tier, number> = { grail: 0, key: 1, star: 2 };

function compareNumbers(a: string, b: string): number {
  const na = Number.parseInt(a.replace(/[^0-9]/g, ""), 10);
  const nb = Number.parseInt(b.replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** Listed cards in a year or year range, best first (grail, key, star), then year, then card number. */
export function keyCardsFor(q: { year?: number | null; yearEnd?: number | null; brand?: string | null; sport?: Sport | null }): KeyCard[] {
  try {
    const from = q.year ?? null;
    const to = q.yearEnd ?? q.year ?? null;
    const brand = q.brand ? normalizeBrand(q.brand) : "";
    return KEY_CARDS.filter((k) => {
      if (from != null && k.year < from) return false;
      if (to != null && k.year > to) return false;
      if (brand && normalizeBrand(k.brand) !== brand) return false;
      if (q.sport && k.sport !== q.sport) return false;
      return true;
    }).sort(
      (a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
        a.year - b.year ||
        compareNumbers(a.cardNumber, b.cardNumber) ||
        a.setName.localeCompare(b.setName),
    );
  } catch {
    return [];
  }
}
