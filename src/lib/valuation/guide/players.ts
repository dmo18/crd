import type { Sport } from "@/db/schema";
import { normalizeName } from "@/lib/catalog/normalize";

/**
 * A small built-in list of players whose cards sell above the rest, used
 * when the stored Wikidata facts have no answer. Only names known for sure.
 * - great: all-time greats; their cards sell in every era.
 * - hof: Hall of Fame members (and a few certain to be, still active or
 *   just retired, whose cards sell like Hall of Famers').
 * - star: famous players who are not in the Hall of Fame but whose cards
 *   sell like stars (for example Barry Bonds, Pete Rose).
 * Written in late 2026 from general sports knowledge.
 */
export type ListedTier = "great" | "hof" | "star";

/**
 * [name, first playing year, last playing year or null while active]. The
 * first year is the first top level season, or earlier where the player's
 * cards start earlier (a Japanese or European league, the USFL, the WHA).
 * Where a year was not certain it was widened, never narrowed.
 */
type Listed = [name: string, first: number, last: number | null];

const LIST: Record<"baseball" | "basketball" | "football" | "hockey", Record<ListedTier, Listed[]>> = {
  baseball: {
    great: [
      ["Babe Ruth", 1914, 1935], ["Lou Gehrig", 1923, 1939], ["Ty Cobb", 1905, 1928], ["Honus Wagner", 1897, 1917],
      ["Mickey Mantle", 1951, 1968], ["Willie Mays", 1951, 1973], ["Hank Aaron", 1954, 1976], ["Ted Williams", 1939, 1960],
      ["Jackie Robinson", 1947, 1956], ["Roberto Clemente", 1955, 1972], ["Sandy Koufax", 1955, 1966], ["Joe DiMaggio", 1936, 1951],
      ["Stan Musial", 1941, 1963], ["Nolan Ryan", 1966, 1993], ["Ken Griffey Jr.", 1989, 2010], ["Derek Jeter", 1995, 2014],
      ["Cal Ripken Jr.", 1981, 2001], ["Mike Trout", 2011, null], ["Shohei Ohtani", 2013, null],
    ],
    hof: [
      ["Rickey Henderson", 1979, 2003], ["Tony Gwynn", 1982, 2001], ["Wade Boggs", 1982, 1999], ["Ryne Sandberg", 1981, 1997],
      ["Kirby Puckett", 1984, 1995], ["Greg Maddux", 1986, 2008], ["Frank Thomas", 1990, 2008], ["Randy Johnson", 1988, 2009],
      ["John Smoltz", 1988, 2009], ["Mariano Rivera", 1995, 2013], ["Tom Glavine", 1987, 2008], ["Chipper Jones", 1993, 2012],
      ["Pedro Martinez", 1992, 2009], ["Ozzie Smith", 1978, 1996], ["George Brett", 1973, 1993], ["Robin Yount", 1974, 1993],
      ["Mike Schmidt", 1972, 1989], ["Eddie Murray", 1977, 1997], ["Paul Molitor", 1978, 1998], ["Dave Winfield", 1973, 1995],
      ["Andre Dawson", 1976, 1996], ["Reggie Jackson", 1967, 1987], ["Johnny Bench", 1967, 1983], ["Tom Seaver", 1967, 1986],
      ["Rod Carew", 1967, 1985], ["Carl Yastrzemski", 1961, 1983], ["Bob Gibson", 1959, 1975], ["Ernie Banks", 1953, 1971],
      ["Al Kaline", 1953, 1974], ["Brooks Robinson", 1955, 1977], ["Yogi Berra", 1946, 1965], ["Whitey Ford", 1950, 1967],
      ["Warren Spahn", 1942, 1965], ["Steve Carlton", 1965, 1988], ["Gary Carter", 1974, 1992], ["Barry Larkin", 1986, 2004],
      ["Roberto Alomar", 1988, 2004], ["Craig Biggio", 1988, 2007], ["Jeff Bagwell", 1991, 2005], ["Mike Piazza", 1992, 2007],
      ["Ivan Rodriguez", 1991, 2011], ["Dennis Eckersley", 1975, 1998], ["Ichiro Suzuki", 1992, 2019], ["Vladimir Guerrero", 1996, 2011],
      ["Jim Thome", 1991, 2012], ["David Ortiz", 1997, 2016], ["Edgar Martinez", 1987, 2004], ["Trevor Hoffman", 1993, 2010],
      ["Albert Pujols", 2001, 2022], ["Willie McCovey", 1959, 1980], ["Harmon Killebrew", 1954, 1975], ["Frank Robinson", 1956, 1976],
      ["Juan Marichal", 1960, 1975],
    ],
    star: [
      ["Barry Bonds", 1986, 2007], ["Roger Clemens", 1984, 2007], ["Mark McGwire", 1986, 2001], ["Pete Rose", 1963, 1986],
      ["Bo Jackson", 1986, 1994], ["Don Mattingly", 1982, 1995], ["Jose Canseco", 1985, 2001], ["Alex Rodriguez", 1994, 2016],
      ["Sammy Sosa", 1989, 2007], ["Darryl Strawberry", 1983, 1999], ["Dwight Gooden", 1984, 2000], ["Aaron Judge", 2016, null],
    ],
  },
  basketball: {
    great: [
      ["Michael Jordan", 1984, 2003], ["LeBron James", 2003, null], ["Kareem Abdul-Jabbar", 1969, 1989], ["Lew Alcindor", 1969, 1971],
      ["Magic Johnson", 1979, 1996], ["Larry Bird", 1979, 1992], ["Wilt Chamberlain", 1959, 1973], ["Bill Russell", 1956, 1969],
      ["Kobe Bryant", 1996, 2016], ["Shaquille O'Neal", 1992, 2011], ["Tim Duncan", 1997, 2016], ["Stephen Curry", 2009, null],
    ],
    hof: [
      ["Charles Barkley", 1984, 2000], ["Hakeem Olajuwon", 1984, 2002], ["Patrick Ewing", 1985, 2002], ["Karl Malone", 1985, 2004],
      ["John Stockton", 1984, 2003], ["Clyde Drexler", 1983, 1998], ["Dominique Wilkins", 1982, 1999], ["Isiah Thomas", 1981, 1994],
      ["James Worthy", 1982, 1994], ["Joe Dumars", 1985, 1999], ["Chris Mullin", 1985, 2001], ["Scottie Pippen", 1987, 2004],
      ["Reggie Miller", 1987, 2005], ["Dennis Rodman", 1986, 2006], ["David Robinson", 1989, 2003], ["Julius Erving", 1971, 1987],
      ["Jerry West", 1960, 1974], ["Oscar Robertson", 1960, 1974], ["Elgin Baylor", 1958, 1972], ["Moses Malone", 1974, 1995],
      ["Kevin McHale", 1980, 1993], ["Robert Parish", 1976, 1997], ["Allen Iverson", 1996, 2010], ["Kevin Garnett", 1995, 2016],
      ["Dirk Nowitzki", 1998, 2019], ["Steve Nash", 1996, 2015], ["Jason Kidd", 1994, 2013], ["Gary Payton", 1990, 2007],
      ["Pete Maravich", 1970, 1980], ["Kevin Durant", 2007, null],
    ],
    star: [],
  },
  football: {
    great: [
      ["Jim Brown", 1957, 1965], ["Johnny Unitas", 1956, 1973], ["Joe Montana", 1979, 1994], ["Jerry Rice", 1985, 2004],
      ["Walter Payton", 1975, 1987], ["Tom Brady", 2000, 2022], ["Peyton Manning", 1998, 2015], ["Barry Sanders", 1989, 1998],
      ["Lawrence Taylor", 1981, 1993], ["Dan Marino", 1983, 1999], ["John Elway", 1983, 1998], ["Emmitt Smith", 1990, 2004],
      ["Joe Namath", 1965, 1977],
    ],
    hof: [
      ["Steve Young", 1984, 1999], ["Jim Kelly", 1983, 1996], ["Reggie White", 1984, 2000], ["Troy Aikman", 1989, 2000],
      ["Deion Sanders", 1989, 2005], ["Brett Favre", 1991, 2010], ["Terry Bradshaw", 1970, 1983], ["Roger Staubach", 1969, 1979],
      ["Dick Butkus", 1965, 1973], ["Gale Sayers", 1965, 1971], ["Bart Starr", 1956, 1971], ["Eric Dickerson", 1983, 1993],
      ["Marcus Allen", 1982, 1997], ["Tony Dorsett", 1977, 1988], ["Earl Campbell", 1978, 1985], ["Thurman Thomas", 1988, 2000],
      ["Warren Moon", 1978, 2000], ["Michael Irvin", 1988, 1999], ["Cris Carter", 1987, 2002], ["Bruce Smith", 1985, 2003],
      ["Junior Seau", 1990, 2009], ["Randy Moss", 1998, 2012], ["LaDainian Tomlinson", 2001, 2011], ["Marshall Faulk", 1994, 2006],
    ],
    star: [["Bo Jackson", 1987, 1990], ["Patrick Mahomes", 2017, null]],
  },
  hockey: {
    great: [
      ["Wayne Gretzky", 1978, 1999], ["Mario Lemieux", 1984, 2006], ["Gordie Howe", 1946, 1980], ["Bobby Orr", 1966, 1979],
      ["Sidney Crosby", 2005, null], ["Alex Ovechkin", 2005, null], ["Connor McDavid", 2015, null],
    ],
    hof: [
      ["Mark Messier", 1978, 2004], ["Ray Bourque", 1979, 2001], ["Steve Yzerman", 1983, 2006], ["Patrick Roy", 1984, 2003],
      ["Brett Hull", 1986, 2006], ["Jaromir Jagr", 1988, 2018], ["Mike Bossy", 1977, 1987], ["Bryan Trottier", 1975, 1994],
      ["Paul Coffey", 1980, 2001], ["Joe Sakic", 1988, 2009], ["Dominik Hasek", 1981, 2008], ["Martin Brodeur", 1991, 2015],
      ["Nicklas Lidstrom", 1991, 2012], ["Teemu Selanne", 1988, 2014], ["Eric Lindros", 1992, 2007], ["Pavel Bure", 1988, 2003],
      ["Peter Forsberg", 1990, 2011], ["Mike Modano", 1988, 2011], ["Luc Robitaille", 1986, 2006], ["Bobby Hull", 1957, 1980],
      ["Phil Esposito", 1963, 1981], ["Stan Mikita", 1958, 1980], ["Ken Dryden", 1970, 1979], ["Guy Lafleur", 1971, 1991],
      ["Marcel Dionne", 1971, 1989], ["Jean Beliveau", 1950, 1971], ["Maurice Richard", 1942, 1960],
    ],
    star: [],
  },
};

/**
 * Other players with exactly the same name as a listed one, whose cards
 * sell as commons: a card from their years that falls after the listed
 * player's career is theirs, not the listed player's. Cards from before a
 * listed player's first years are never his in any case.
 */
const NAMESAKES: { name: string; sport: ListedSport; first: number; last: number }[] = [
  { name: "Frank Thomas", sport: "baseball", first: 1951, last: 1966 },
  { name: "Randy Johnson", sport: "baseball", first: 1980, last: 1984 },
  { name: "Bob Gibson", sport: "baseball", first: 1983, last: 1987 },
  { name: "Bill Russell", sport: "baseball", first: 1969, last: 1986 },
  { name: "Reggie Jackson", sport: "basketball", first: 2011, last: 2026 },
  { name: "Bruce Smith", sport: "football", first: 1945, last: 1948 },
  // The son; a card that leaves out his "Jr." reads like the father's name.
  { name: "Vladimir Guerrero", sport: "baseball", first: 2016, last: 2026 },
];

/** Cards come out a few years before a player's first season (draft, minor league, college and Olympic cards). */
export const YEARS_BEFORE = 3;
/** And a few years after the last one, from sets still printed or late in the season. */
export const YEARS_AFTER = 3;

type ListedSport = keyof typeof LIST;
type Entry = { sport: ListedSport; tier: ListedTier; first: number; last: number | null };

const INDEX: Map<string, Entry[]> = (() => {
  const map = new Map<string, Entry[]>();
  for (const sport of Object.keys(LIST) as ListedSport[]) {
    for (const tier of ["great", "hof", "star"] as const) {
      for (const [name, first, last] of LIST[sport][tier]) {
        const key = normalizeName(name);
        map.set(key, [...(map.get(key) ?? []), { sport, tier, first, last }]);
      }
    }
  }
  return map;
})();

/** Every listed name, for tests. */
export function listedNames(): { name: string; sport: ListedSport; tier: ListedTier; first: number; last: number | null }[] {
  return (Object.keys(LIST) as ListedSport[]).flatMap((sport) =>
    (["great", "hof", "star"] as const).flatMap((tier) => LIST[sport][tier].map(([name, first, last]) => ({ name, sport, tier, first, last }))),
  );
}

/**
 * The card's year can be this listed player's: not before his first years,
 * and after his career only when no other player of that name played then.
 */
function fitsYear(key: string, e: Entry, year: number, sport: Sport | null | undefined): boolean {
  if (year < e.first - YEARS_BEFORE) return false;
  if (e.last == null || year <= e.last + YEARS_AFTER) return true;
  // A namesake in another sport counts only when the card's sport is not known.
  return !namesakePlayed(key, year, (n) => n === e.sport || !sport);
}

function namesakePlayed(key: string, year: number, sportFits: (s: ListedSport) => boolean): boolean {
  return NAMESAKES.some((n) => normalizeName(n.name) === key && sportFits(n.sport) && year >= n.first - YEARS_BEFORE && year <= n.last + YEARS_AFTER);
}

/**
 * The listed tier for a player name, or null. When the card's sport is known
 * it must match; without a sport a name listed in one sport only is used.
 * With the card's year, the year must fit the player's playing years: a 1955
 * "Frank Thomas" is not the 1990s Hall of Famer.
 */
export function listedTier(name: string | null | undefined, sport: Sport | null | undefined, year?: number | null): ListedTier | null {
  if (!name) return null;
  const key = normalizeName(name);
  let found = INDEX.get(key);
  if (!found) return null;
  if (year != null) found = found.filter((e) => fitsYear(key, e, year, sport));
  if (sport && sport in LIST) return found.find((f) => f.sport === sport)?.tier ?? null;
  if (sport) return null;
  if (found.length !== 1) return null;
  const only = found[0];
  // No sport: a namesake in another sport playing that year makes the name unclear.
  if (year != null && namesakePlayed(key, year, (s) => s !== only.sport)) return null;
  return only.tier;
}
