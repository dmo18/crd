import type { Sport } from "@/db/schema";
import { normalizeBrand, normalizeCardNumber, normalizeName } from "@/lib/catalog/normalize";

/**
 * Key cards that break the guide's rules: famous rookies and errors.
 * A sibling of the recognition list in src/lib/free/key-cards.ts (that list
 * stays 1980 to 1995 and has no prices). Card numbers there are reused here.
 *
 * Each range is a WIDE rough raw range in whole US cents for one clean
 * (near mint looking) ungraded copy, written in late 2026 from general hobby
 * knowledge, never from sales data. A card is listed only when its year,
 * product, number and a sensible range were all known with confidence; cards
 * with any doubt were left out. Grading and condition are applied on top by
 * the rules in ./index.ts.
 *
 * Basketball and hockey years are the first year of the season (1986 means 1986 to 87).
 */
export type PricedCard = {
  sport: Sport;
  year: number;
  brand: string;
  setName: string;
  cardNumber: string;
  player: string;
  lowCents: number;
  highCents: number;
  /** True for a listed error version: matched only when the item is marked as an error. */
  isError: boolean;
};

const B: Sport = "baseball";
const K: Sport = "basketball";
const F: Sport = "football";
const H: Sport = "hockey";

/** Ranges are written in whole dollars for readability and kept in cents. */
function p(sport: Sport, year: number, brand: string, setName: string, cardNumber: string, player: string, lowDollars: number, highDollars: number, error = false): PricedCard {
  return { sport, year, brand, setName, cardNumber, player, lowCents: lowDollars * 100, highCents: highDollars * 100, isError: error };
}

export const PRICED_CARDS: readonly PricedCard[] = [
  // Baseball before 1980
  p(B, 1948, "Leaf", "Leaf", "3", "Babe Ruth", 2000, 50000),
  p(B, 1948, "Leaf", "Leaf", "79", "Jackie Robinson", 3000, 100000),
  p(B, 1951, "Bowman", "Bowman", "253", "Mickey Mantle", 5000, 150000),
  p(B, 1951, "Bowman", "Bowman", "305", "Willie Mays", 2000, 50000),
  p(B, 1952, "Topps", "Topps", "311", "Mickey Mantle", 10000, 500000),
  p(B, 1952, "Topps", "Topps", "261", "Willie Mays", 1000, 30000),
  p(B, 1952, "Topps", "Topps", "1", "Andy Pafko", 500, 30000),
  p(B, 1953, "Topps", "Topps", "82", "Mickey Mantle", 1000, 30000),
  p(B, 1954, "Topps", "Topps", "128", "Hank Aaron", 2000, 50000),
  p(B, 1954, "Topps", "Topps", "94", "Ernie Banks", 500, 10000),
  p(B, 1954, "Topps", "Topps", "201", "Al Kaline", 300, 5000),
  p(B, 1954, "Topps", "Topps", "1", "Ted Williams", 500, 8000),
  p(B, 1955, "Topps", "Topps", "164", "Roberto Clemente", 2000, 50000),
  p(B, 1955, "Topps", "Topps", "123", "Sandy Koufax", 500, 15000),
  p(B, 1956, "Topps", "Topps", "135", "Mickey Mantle", 500, 15000),
  p(B, 1957, "Topps", "Topps", "328", "Brooks Robinson", 200, 3000),
  p(B, 1959, "Topps", "Topps", "514", "Bob Gibson", 200, 3000),
  p(B, 1963, "Topps", "Topps", "537", "Pete Rose", 300, 5000),
  p(B, 1968, "Topps", "Topps", "177", "Nolan Ryan", 300, 5000),
  p(B, 1969, "Topps", "Topps", "260", "Reggie Jackson", 100, 2000),
  p(B, 1973, "Topps", "Topps", "615", "Mike Schmidt", 50, 800),
  p(B, 1974, "Topps", "Topps", "456", "Dave Winfield", 10, 150),
  p(B, 1975, "Topps", "Topps", "228", "George Brett", 30, 300),
  p(B, 1975, "Topps", "Topps", "223", "Robin Yount", 20, 200),
  p(B, 1977, "Topps", "Topps", "473", "Andre Dawson", 10, 100),
  p(B, 1978, "Topps", "Topps", "36", "Eddie Murray", 10, 100),
  p(B, 1978, "Topps", "Topps", "707", "Paul Molitor", 10, 100),
  p(B, 1979, "Topps", "Topps", "116", "Ozzie Smith", 20, 200),

  // Baseball 1980 to 1995
  p(B, 1980, "Topps", "Topps", "482", "Rickey Henderson", 30, 150),
  p(B, 1982, "Topps", "Topps", "21", "Cal Ripken Jr.", 20, 80),
  p(B, 1982, "Topps", "Topps Traded", "98T", "Cal Ripken Jr.", 50, 250),
  p(B, 1982, "Fleer", "Fleer", "176", "Cal Ripken Jr.", 10, 40),
  p(B, 1982, "Donruss", "Donruss", "405", "Cal Ripken Jr.", 10, 40),
  p(B, 1983, "Topps", "Topps", "482", "Tony Gwynn", 10, 40),
  p(B, 1983, "Topps", "Topps", "498", "Wade Boggs", 5, 25),
  p(B, 1983, "Topps", "Topps", "83", "Ryne Sandberg", 10, 40),
  p(B, 1983, "Fleer", "Fleer", "360", "Tony Gwynn", 5, 25),
  p(B, 1983, "Fleer", "Fleer", "179", "Wade Boggs", 3, 15),
  p(B, 1983, "Fleer", "Fleer", "507", "Ryne Sandberg", 5, 25),
  p(B, 1983, "Donruss", "Donruss", "598", "Tony Gwynn", 5, 25),
  p(B, 1983, "Donruss", "Donruss", "586", "Wade Boggs", 3, 15),
  p(B, 1983, "Donruss", "Donruss", "277", "Ryne Sandberg", 5, 25),
  p(B, 1983, "Topps", "Topps Traded", "108T", "Darryl Strawberry", 5, 25),
  p(B, 1984, "Topps", "Topps", "8", "Don Mattingly", 5, 25),
  p(B, 1984, "Fleer", "Fleer", "131", "Don Mattingly", 5, 30),
  p(B, 1984, "Donruss", "Donruss", "248", "Don Mattingly", 15, 60),
  p(B, 1984, "Fleer", "Fleer Update", "U-27", "Roger Clemens", 75, 300),
  p(B, 1984, "Fleer", "Fleer Update", "U-93", "Kirby Puckett", 50, 200),
  p(B, 1984, "Fleer", "Fleer Update", "U-43", "Dwight Gooden", 15, 60),
  p(B, 1984, "Topps", "Topps Traded", "42T", "Dwight Gooden", 3, 15),
  p(B, 1985, "Topps", "Topps", "401", "Mark McGwire", 10, 40),
  p(B, 1985, "Topps", "Topps", "181", "Roger Clemens", 10, 40),
  p(B, 1985, "Topps", "Topps", "536", "Kirby Puckett", 10, 40),
  p(B, 1985, "Topps", "Topps", "620", "Dwight Gooden", 2, 10),
  p(B, 1985, "Fleer", "Fleer", "155", "Roger Clemens", 10, 40),
  p(B, 1985, "Fleer", "Fleer", "286", "Kirby Puckett", 10, 40),
  p(B, 1985, "Donruss", "Donruss", "273", "Roger Clemens", 10, 40),
  p(B, 1985, "Donruss", "Donruss", "438", "Kirby Puckett", 10, 40),
  p(B, 1986, "Donruss", "Donruss", "39", "Jose Canseco", 5, 25),
  p(B, 1986, "Donruss", "Donruss Rookies", "22", "Jose Canseco", 3, 15),
  p(B, 1986, "Topps", "Topps Traded", "11T", "Barry Bonds", 15, 60),
  p(B, 1986, "Topps", "Topps Traded", "20T", "Jose Canseco", 2, 10),
  p(B, 1986, "Topps", "Topps Traded", "50T", "Bo Jackson", 3, 15),
  p(B, 1987, "Topps", "Topps", "320", "Barry Bonds", 5, 25),
  p(B, 1987, "Topps", "Topps", "366", "Mark McGwire", 1, 5),
  p(B, 1987, "Topps", "Topps", "170", "Bo Jackson", 1, 5),
  p(B, 1987, "Fleer", "Fleer", "604", "Barry Bonds", 15, 60),
  p(B, 1987, "Fleer", "Fleer", "396", "Mark McGwire", 5, 20),
  p(B, 1987, "Donruss", "Donruss", "361", "Barry Bonds", 5, 25),
  p(B, 1987, "Donruss", "Donruss", "46", "Mark McGwire", 2, 10),
  p(B, 1987, "Donruss", "Donruss", "35", "Bo Jackson", 1, 5),
  p(B, 1987, "Donruss", "Donruss", "36", "Greg Maddux", 5, 25),
  p(B, 1987, "Topps", "Topps Traded", "70T", "Greg Maddux", 5, 20),
  p(B, 1989, "Upper Deck", "Upper Deck", "1", "Ken Griffey Jr.", 40, 200),
  p(B, 1989, "Upper Deck", "Upper Deck", "25", "Randy Johnson", 5, 25),
  p(B, 1989, "Upper Deck", "Upper Deck", "17", "John Smoltz", 2, 10),
  p(B, 1989, "Upper Deck", "Upper Deck", "13", "Gary Sheffield", 1, 5),
  p(B, 1989, "Upper Deck", "Upper Deck", "357", "Dale Murphy", 3, 30, true),
  p(B, 1989, "Fleer", "Fleer", "548", "Ken Griffey Jr.", 10, 40),
  p(B, 1989, "Fleer", "Fleer", "616", "Bill Ripken", 10, 75, true),
  p(B, 1989, "Donruss", "Donruss", "33", "Ken Griffey Jr.", 10, 40),
  p(B, 1989, "Donruss", "Donruss", "42", "Randy Johnson", 2, 10),
  p(B, 1989, "Bowman", "Bowman", "220", "Ken Griffey Jr.", 10, 40),
  p(B, 1989, "Topps", "Topps Traded", "41T", "Ken Griffey Jr.", 10, 40),
  p(B, 1989, "Score", "Score Traded", "100T", "Ken Griffey Jr.", 5, 25),
  p(B, 1990, "Topps", "Topps", "414", "Frank Thomas", 3, 15),
  p(B, 1990, "Topps", "Topps", "414", "Frank Thomas", 500, 5000, true),
  p(B, 1990, "Leaf", "Leaf", "300", "Frank Thomas", 10, 50),
  p(B, 1992, "Bowman", "Bowman", "302", "Mariano Rivera", 20, 100),
  p(B, 1993, "Topps", "Topps", "98", "Derek Jeter", 10, 50),
  p(B, 1993, "Upper Deck", "Upper Deck", "449", "Derek Jeter", 10, 50),
  p(B, 1993, "Upper Deck", "SP", "279", "Derek Jeter", 100, 500),
  p(B, 1994, "Upper Deck", "SP", "15", "Alex Rodriguez", 20, 100),

  // Baseball after 1995
  p(B, 2011, "Topps", "Topps Update", "US175", "Mike Trout", 50, 300),

  // Basketball
  p(K, 1957, "Topps", "Topps", "77", "Bill Russell", 1000, 20000),
  p(K, 1961, "Fleer", "Fleer", "8", "Wilt Chamberlain", 1000, 20000),
  p(K, 1969, "Topps", "Topps", "25", "Lew Alcindor", 500, 10000),
  p(K, 1984, "Star", "Star", "101", "Michael Jordan", 1000, 15000),
  p(K, 1986, "Fleer", "Fleer", "57", "Michael Jordan", 1500, 10000),
  p(K, 1986, "Fleer", "Fleer Stickers", "8", "Michael Jordan", 300, 2000),
  p(K, 1986, "Fleer", "Fleer", "7", "Charles Barkley", 30, 150),
  p(K, 1986, "Fleer", "Fleer", "82", "Hakeem Olajuwon", 50, 250),
  p(K, 1986, "Fleer", "Fleer", "32", "Patrick Ewing", 20, 100),
  p(K, 1986, "Fleer", "Fleer", "68", "Karl Malone", 20, 100),
  p(K, 1986, "Fleer", "Fleer", "26", "Clyde Drexler", 15, 80),
  p(K, 1986, "Fleer", "Fleer", "121", "Dominique Wilkins", 20, 100),
  p(K, 1986, "Fleer", "Fleer", "109", "Isiah Thomas", 15, 80),
  p(K, 1986, "Fleer", "Fleer", "131", "James Worthy", 10, 50),
  p(K, 1986, "Fleer", "Fleer", "27", "Joe Dumars", 10, 50),
  p(K, 1986, "Fleer", "Fleer", "77", "Chris Mullin", 5, 30),
  p(K, 1987, "Fleer", "Fleer", "59", "Michael Jordan", 150, 800),
  p(K, 1988, "Fleer", "Fleer", "20", "Scottie Pippen", 30, 150),
  p(K, 1988, "Fleer", "Fleer", "57", "Reggie Miller", 10, 50),
  p(K, 1988, "Fleer", "Fleer", "43", "Dennis Rodman", 10, 50),
  p(K, 1989, "NBA Hoops", "NBA Hoops", "138", "David Robinson", 3, 15),
  p(K, 1992, "Upper Deck", "Upper Deck", "1", "Shaquille O'Neal", 5, 25),
  p(K, 1992, "Fleer", "Fleer", "401", "Shaquille O'Neal", 5, 25),
  p(K, 1992, "Fleer", "Fleer Ultra", "328", "Shaquille O'Neal", 5, 25),
  p(K, 1992, "NBA Hoops", "NBA Hoops", "442", "Shaquille O'Neal", 3, 15),
  p(K, 1996, "Topps", "Topps", "138", "Kobe Bryant", 50, 300),
  p(K, 1996, "Topps", "Topps Chrome", "138", "Kobe Bryant", 500, 3000),
  p(K, 2003, "Topps", "Topps", "221", "LeBron James", 100, 600),
  p(K, 2003, "Topps", "Topps Chrome", "111", "LeBron James", 500, 3000),

  // Football
  p(F, 1957, "Topps", "Topps", "138", "Johnny Unitas", 300, 5000),
  p(F, 1958, "Topps", "Topps", "62", "Jim Brown", 500, 10000),
  p(F, 1965, "Topps", "Topps", "122", "Joe Namath", 500, 8000),
  p(F, 1971, "Topps", "Topps", "156", "Terry Bradshaw", 50, 800),
  p(F, 1976, "Topps", "Topps", "148", "Walter Payton", 100, 1500),
  p(F, 1981, "Topps", "Topps", "216", "Joe Montana", 100, 600),
  p(F, 1984, "Topps", "Topps", "63", "John Elway", 30, 150),
  p(F, 1984, "Topps", "Topps", "123", "Dan Marino", 30, 150),
  p(F, 1984, "Topps", "Topps USFL", "36", "Jim Kelly", 50, 300),
  p(F, 1984, "Topps", "Topps USFL", "52", "Steve Young", 100, 500),
  p(F, 1984, "Topps", "Topps USFL", "58", "Reggie White", 30, 150),
  p(F, 1986, "Topps", "Topps", "161", "Jerry Rice", 50, 250),
  p(F, 1986, "Topps", "Topps", "374", "Steve Young", 10, 50),
  p(F, 1986, "Topps", "Topps", "275", "Reggie White", 10, 40),
  p(F, 1987, "Topps", "Topps", "362", "Jim Kelly", 5, 25),
  p(F, 1988, "Topps", "Topps", "327", "Bo Jackson", 5, 25),
  p(F, 1989, "Score", "Score", "257", "Barry Sanders", 20, 100),
  p(F, 1989, "Score", "Score", "270", "Troy Aikman", 10, 50),
  p(F, 1989, "Score", "Score", "246", "Deion Sanders", 10, 50),
  p(F, 1989, "Topps", "Topps Traded", "83T", "Barry Sanders", 10, 40),
  p(F, 1990, "Score", "Score Supplemental", "101T", "Emmitt Smith", 10, 50),
  p(F, 1990, "Topps", "Topps Traded", "27T", "Emmitt Smith", 5, 30),
  p(F, 1991, "Topps", "Stadium Club", "94", "Brett Favre", 20, 100),

  // Hockey
  p(H, 1951, "Parkhurst", "Parkhurst", "66", "Gordie Howe", 1000, 30000),
  p(H, 1966, "Topps", "Topps", "35", "Bobby Orr", 1000, 20000),
  p(H, 1979, "O-Pee-Chee", "O-Pee-Chee", "18", "Wayne Gretzky", 1000, 8000),
  p(H, 1979, "Topps", "Topps", "18", "Wayne Gretzky", 300, 3000),
  p(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "140", "Ray Bourque", 30, 150),
  p(H, 1980, "Topps", "Topps", "140", "Ray Bourque", 10, 50),
  p(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "289", "Mark Messier", 50, 300),
  p(H, 1980, "O-Pee-Chee", "O-Pee-Chee", "250", "Wayne Gretzky", 50, 300),
  p(H, 1984, "O-Pee-Chee", "O-Pee-Chee", "67", "Steve Yzerman", 50, 300),
  p(H, 1984, "Topps", "Topps", "49", "Steve Yzerman", 20, 100),
  p(H, 1985, "O-Pee-Chee", "O-Pee-Chee", "9", "Mario Lemieux", 200, 1000),
  p(H, 1985, "Topps", "Topps", "9", "Mario Lemieux", 100, 500),
  p(H, 1986, "O-Pee-Chee", "O-Pee-Chee", "53", "Patrick Roy", 50, 250),
  p(H, 1986, "Topps", "Topps", "53", "Patrick Roy", 20, 100),
  p(H, 1988, "O-Pee-Chee", "O-Pee-Chee", "66", "Brett Hull", 10, 50),
  p(H, 1990, "Upper Deck", "Upper Deck", "356", "Jaromir Jagr", 3, 15),
  p(H, 2005, "Upper Deck", "Young Guns", "201", "Sidney Crosby", 300, 1500),
  p(H, 2005, "Upper Deck", "Young Guns", "443", "Alex Ovechkin", 150, 800),
  p(H, 2015, "Upper Deck", "Young Guns", "201", "Connor McDavid", 200, 1000),
];

export type PricedCardQuery = {
  sport?: Sport | null;
  year?: number | null;
  brand?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  isError?: boolean | null;
};

const lastName = (s: string) => normalizeName(s).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").trim().split(" ").pop() ?? "";

/**
 * Finds one priced key card. Needs the year, the brand and the card number.
 * When the item names a player, the last name must agree. A set name that
 * says more than the brand (for example "Topps Traded") must agree too; the
 * set may also stand in the brand field ("SP", "Stadium Club").
 * Without a set name the brand's base set is used, or another set of the
 * same brand only when the player agrees. Error versions are used only for
 * items marked as errors. Returns null on no match or a tie.
 */
export function findPricedCard(q: PricedCardQuery): PricedCard | null {
  if (q.year == null || !q.brand || !q.cardNumber) return null;
  const brand = normalizeBrand(q.brand);
  const num = normalizeCardNumber(q.cardNumber);
  if (!brand || !num) return null;
  const set = q.setName ? normalizeBrand(q.setName) : "";
  const pool = PRICED_CARDS.filter((c) => {
    if (c.year !== q.year || normalizeCardNumber(c.cardNumber) !== num) return false;
    if (normalizeBrand(c.brand) !== brand && normalizeBrand(c.setName) !== brand) return false;
    if (q.sport && c.sport !== q.sport) return false;
    if (q.player && lastName(q.player) !== lastName(c.player)) return false;
    return c.isError === Boolean(q.isError);
  });
  let found: PricedCard[];
  if (set && set !== brand) {
    found = pool.filter((c) => {
      const cSet = normalizeBrand(c.setName);
      const cBrand = normalizeBrand(c.brand);
      // "Traded" or "Topps Traded" for Topps Traded; "SP" or "Upper Deck SP" for SP.
      return cSet === set || cSet === cBrand + set || set === cBrand + cSet;
    });
  } else {
    const base = pool.filter((c) => normalizeBrand(c.setName) === brand);
    found = base.length > 0 ? base : q.player ? pool : [];
  }
  return found.length === 1 ? found[0] : null;
}
