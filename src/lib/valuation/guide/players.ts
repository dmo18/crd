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

const LIST: Record<"baseball" | "basketball" | "football" | "hockey", Record<ListedTier, string[]>> = {
  baseball: {
    great: [
      "Babe Ruth", "Lou Gehrig", "Ty Cobb", "Honus Wagner", "Mickey Mantle", "Willie Mays", "Hank Aaron",
      "Ted Williams", "Jackie Robinson", "Roberto Clemente", "Sandy Koufax", "Joe DiMaggio", "Stan Musial",
      "Nolan Ryan", "Ken Griffey Jr.", "Derek Jeter", "Cal Ripken Jr.", "Mike Trout", "Shohei Ohtani",
    ],
    hof: [
      "Rickey Henderson", "Tony Gwynn", "Wade Boggs", "Ryne Sandberg", "Kirby Puckett", "Greg Maddux",
      "Frank Thomas", "Randy Johnson", "John Smoltz", "Mariano Rivera", "Tom Glavine", "Chipper Jones",
      "Pedro Martinez", "Ozzie Smith", "George Brett", "Robin Yount", "Mike Schmidt", "Eddie Murray",
      "Paul Molitor", "Dave Winfield", "Andre Dawson", "Reggie Jackson", "Johnny Bench", "Tom Seaver",
      "Rod Carew", "Carl Yastrzemski", "Bob Gibson", "Ernie Banks", "Al Kaline", "Brooks Robinson",
      "Yogi Berra", "Whitey Ford", "Warren Spahn", "Steve Carlton", "Gary Carter", "Barry Larkin",
      "Roberto Alomar", "Craig Biggio", "Jeff Bagwell", "Mike Piazza", "Ivan Rodriguez", "Dennis Eckersley",
      "Ichiro Suzuki", "Vladimir Guerrero", "Jim Thome", "David Ortiz", "Edgar Martinez", "Trevor Hoffman",
      "Albert Pujols", "Willie McCovey", "Harmon Killebrew", "Frank Robinson", "Juan Marichal",
    ],
    star: [
      "Barry Bonds", "Roger Clemens", "Mark McGwire", "Pete Rose", "Bo Jackson", "Don Mattingly",
      "Jose Canseco", "Alex Rodriguez", "Sammy Sosa", "Darryl Strawberry", "Dwight Gooden", "Aaron Judge",
    ],
  },
  basketball: {
    great: [
      "Michael Jordan", "LeBron James", "Kareem Abdul-Jabbar", "Lew Alcindor", "Magic Johnson", "Larry Bird",
      "Wilt Chamberlain", "Bill Russell", "Kobe Bryant", "Shaquille O'Neal", "Tim Duncan", "Stephen Curry",
    ],
    hof: [
      "Charles Barkley", "Hakeem Olajuwon", "Patrick Ewing", "Karl Malone", "John Stockton", "Clyde Drexler",
      "Dominique Wilkins", "Isiah Thomas", "James Worthy", "Joe Dumars", "Chris Mullin", "Scottie Pippen",
      "Reggie Miller", "Dennis Rodman", "David Robinson", "Julius Erving", "Jerry West", "Oscar Robertson",
      "Elgin Baylor", "Moses Malone", "Kevin McHale", "Robert Parish", "Allen Iverson", "Kevin Garnett",
      "Dirk Nowitzki", "Steve Nash", "Jason Kidd", "Gary Payton", "Pete Maravich", "Kevin Durant",
    ],
    star: [],
  },
  football: {
    great: [
      "Jim Brown", "Johnny Unitas", "Joe Montana", "Jerry Rice", "Walter Payton", "Tom Brady", "Peyton Manning",
      "Barry Sanders", "Lawrence Taylor", "Dan Marino", "John Elway", "Emmitt Smith", "Joe Namath",
    ],
    hof: [
      "Steve Young", "Jim Kelly", "Reggie White", "Troy Aikman", "Deion Sanders", "Brett Favre",
      "Terry Bradshaw", "Roger Staubach", "Dick Butkus", "Gale Sayers", "Bart Starr", "Eric Dickerson",
      "Marcus Allen", "Tony Dorsett", "Earl Campbell", "Thurman Thomas", "Warren Moon", "Michael Irvin",
      "Cris Carter", "Bruce Smith", "Junior Seau", "Randy Moss", "LaDainian Tomlinson", "Marshall Faulk",
    ],
    star: ["Bo Jackson", "Patrick Mahomes"],
  },
  hockey: {
    great: [
      "Wayne Gretzky", "Mario Lemieux", "Gordie Howe", "Bobby Orr", "Sidney Crosby", "Alex Ovechkin",
      "Connor McDavid",
    ],
    hof: [
      "Mark Messier", "Ray Bourque", "Steve Yzerman", "Patrick Roy", "Brett Hull", "Jaromir Jagr", "Mike Bossy",
      "Bryan Trottier", "Paul Coffey", "Joe Sakic", "Dominik Hasek", "Martin Brodeur", "Nicklas Lidstrom",
      "Teemu Selanne", "Eric Lindros", "Pavel Bure", "Peter Forsberg", "Mike Modano", "Luc Robitaille",
      "Bobby Hull", "Phil Esposito", "Stan Mikita", "Ken Dryden", "Guy Lafleur", "Marcel Dionne",
      "Jean Beliveau", "Maurice Richard",
    ],
    star: [],
  },
};

type ListedSport = keyof typeof LIST;

const INDEX: Map<string, { sport: ListedSport; tier: ListedTier }[]> = (() => {
  const map = new Map<string, { sport: ListedSport; tier: ListedTier }[]>();
  for (const sport of Object.keys(LIST) as ListedSport[]) {
    for (const tier of ["great", "hof", "star"] as const) {
      for (const name of LIST[sport][tier]) {
        const key = normalizeName(name);
        map.set(key, [...(map.get(key) ?? []), { sport, tier }]);
      }
    }
  }
  return map;
})();

/** Every listed name, for tests. */
export function listedNames(): { name: string; sport: ListedSport; tier: ListedTier }[] {
  return (Object.keys(LIST) as ListedSport[]).flatMap((sport) =>
    (["great", "hof", "star"] as const).flatMap((tier) => LIST[sport][tier].map((name) => ({ name, sport, tier }))),
  );
}

/**
 * The listed tier for a player name, or null. When the card's sport is known
 * it must match; without a sport a name listed in one sport only is used.
 */
export function listedTier(name: string | null | undefined, sport: Sport | null | undefined): ListedTier | null {
  if (!name) return null;
  const found = INDEX.get(normalizeName(name));
  if (!found) return null;
  if (sport && sport in LIST) return found.find((f) => f.sport === sport)?.tier ?? null;
  if (sport) return null;
  return found.length === 1 ? found[0].tier : null;
}
