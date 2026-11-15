import { createHash } from "node:crypto";
import type { Condition, ProductType, RarityTier, SealState, Sport } from "@/db/schema";
import { checkPhotoCount } from "./limits";
import {
  recognizedItemSchema,
  type Box,
  type RecognitionPhoto,
  type RecognitionRequest,
  type RecognizedItem,
  type RecognizedItemInput,
  type Recognizer,
} from "./types";

/**
 * A free, offline recognizer for previews, tests and trying the app without an
 * AI key. It does not look at the photo: it picks from a small catalog of real
 * cards using a hash of the photo bytes, so the same photo always gives the
 * same answer. Values are rough and marked as sample data.
 */

const SAMPLE_BASIS = "Sample data, not a real estimate.";
const SAMPLE_NOTE = "Sample result from the free practice recognizer. It did not really read this photo.";

type CatalogCard = {
  sport: Sport;
  year: number;
  brand: string;
  setName: string;
  cardNumber: string;
  player: string;
  team: string;
  variation?: string;
  isRookie?: boolean;
  isError?: boolean;
  isParallel?: boolean;
  rarityTier: RarityTier;
  rarityNotes?: string;
  /** Rough raw near mint range in cents. */
  low: number;
  high: number;
  /** Could grading pay off for a sharp copy. */
  gradable?: boolean;
};

/** Real, well known cards from 1980 to 1995. Values are conservative raw near mint guesses. */
export const SAMPLE_CARDS: readonly CatalogCard[] = [
  // Baseball: key rookies and stars
  { sport: "baseball", year: 1989, brand: "Upper Deck", setName: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners", isRookie: true, rarityTier: "key", rarityNotes: "The best known rookie card of the era and the first card in the first Upper Deck set.", low: 3000, high: 8000, gradable: true },
  { sport: "baseball", year: 1985, brand: "Topps", setName: "Topps", cardNumber: "401", player: "Mark McGwire", team: "USA Olympic Team", isRookie: true, rarityTier: "key", rarityNotes: "First Topps card of McGwire, from the 1984 Olympic team subset.", low: 1500, high: 4000, gradable: true },
  { sport: "baseball", year: 1987, brand: "Fleer", setName: "Fleer", cardNumber: "604", player: "Barry Bonds", team: "Pittsburgh Pirates", isRookie: true, rarityTier: "star", rarityNotes: "Fleer rookie card. Blue borders show wear easily.", low: 500, high: 1500, gradable: true },
  { sport: "baseball", year: 1990, brand: "Topps", setName: "Topps", cardNumber: "414", player: "Frank Thomas", team: "Chicago White Sox", isRookie: true, rarityTier: "star", rarityNotes: "Common version with the name printed. The rare no name error is worth far more.", low: 300, high: 800 },
  { sport: "baseball", year: 1989, brand: "Fleer", setName: "Fleer", cardNumber: "616", player: "Billy Ripken", team: "Baltimore Orioles", variation: "Bat knob error", isError: true, rarityTier: "key", rarityNotes: "Famous error with writing on the bat knob. Several corrected versions exist and are worth less.", low: 800, high: 2500, gradable: true },
  { sport: "baseball", year: 1984, brand: "Donruss", setName: "Donruss", cardNumber: "248", player: "Don Mattingly", team: "New York Yankees", isRookie: true, rarityTier: "key", rarityNotes: "Mattingly's best known rookie card.", low: 1500, high: 4000, gradable: true },
  { sport: "baseball", year: 1982, brand: "Topps", setName: "Topps", cardNumber: "21", player: "Cal Ripken Jr.", team: "Baltimore Orioles", variation: "Future Stars", isRookie: true, rarityTier: "key", rarityNotes: "Orioles Future Stars card shared with two other players. Ripken's first Topps card.", low: 2000, high: 5000, gradable: true },
  { sport: "baseball", year: 1986, brand: "Donruss", setName: "Donruss", cardNumber: "39", player: "Jose Canseco", team: "Oakland Athletics", isRookie: true, rarityTier: "minor_star", rarityNotes: "Rated Rookie card, printed in large numbers.", low: 300, high: 800 },
  { sport: "baseball", year: 1987, brand: "Topps", setName: "Topps", cardNumber: "170", player: "Bo Jackson", team: "Kansas City Royals", isRookie: true, rarityTier: "minor_star", rarityNotes: "Future Stars card. Very common, wood borders chip easily.", low: 100, high: 300 },
  { sport: "baseball", year: 1991, brand: "Topps", setName: "Topps", cardNumber: "1", player: "Nolan Ryan", team: "Texas Rangers", variation: "Desert Shield", isParallel: true, rarityTier: "star", rarityNotes: "Desert Shield parallel, sent to troops in the Gulf. Look for the gold foil logo; fakes of the logo exist.", low: 3000, high: 8000, gradable: true },
  // Baseball: commons and common stars
  { sport: "baseball", year: 1990, brand: "Topps", setName: "Topps", cardNumber: "1", player: "Nolan Ryan", team: "Texas Rangers", rarityTier: "minor_star", rarityNotes: "Base card of a star from a very large print run.", low: 50, high: 200 },
  { sport: "baseball", year: 1989, brand: "Topps", setName: "Topps", cardNumber: "1", player: "George Bell", team: "Toronto Blue Jays", variation: "Record Breaker", rarityTier: "common", low: 5, high: 25 },
  { sport: "baseball", year: 1988, brand: "Topps", setName: "Topps", cardNumber: "1", player: "Vince Coleman", team: "St. Louis Cardinals", variation: "Record Breaker", rarityTier: "common", low: 5, high: 25 },
  { sport: "baseball", year: 1987, brand: "Topps", setName: "Topps", cardNumber: "1", player: "Roger Clemens", team: "Boston Red Sox", variation: "Record Breaker", rarityTier: "minor_star", low: 25, high: 100 },
  { sport: "baseball", year: 1990, brand: "Score", setName: "Score", cardNumber: "1", player: "Don Mattingly", team: "New York Yankees", rarityTier: "common", low: 10, high: 50 },
  { sport: "baseball", year: 1989, brand: "Donruss", setName: "Donruss", cardNumber: "1", player: "Mike Greenwell", team: "Boston Red Sox", variation: "Diamond Kings", rarityTier: "common", low: 5, high: 25 },
  { sport: "baseball", year: 1991, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "Troy Afenir", team: "Oakland Athletics", rarityTier: "common", low: 3, high: 15 },
  { sport: "baseball", year: 1990, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "Lance Blankenship", team: "Oakland Athletics", rarityTier: "common", low: 3, high: 15 },
  { sport: "baseball", year: 1988, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "Keith Atherton", team: "Minnesota Twins", rarityTier: "common", low: 3, high: 15 },
  { sport: "baseball", year: 1987, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "Rick Aguilera", team: "New York Mets", rarityTier: "common", low: 5, high: 25 },
  { sport: "baseball", year: 1989, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "Don Baylor", team: "Oakland Athletics", rarityTier: "common", low: 5, high: 25 },
  { sport: "baseball", year: 1990, brand: "Donruss", setName: "Donruss", cardNumber: "1", player: "Bo Jackson", team: "Kansas City Royals", variation: "Diamond Kings", rarityTier: "common", low: 10, high: 50 },
  // Basketball
  { sport: "basketball", year: 1986, brand: "Fleer", setName: "Fleer", cardNumber: "57", player: "Michael Jordan", team: "Chicago Bulls", isRookie: true, rarityTier: "grail", rarityNotes: "The most famous basketball card. Counterfeits are common, so check print quality before trusting it.", low: 150000, high: 400000, gradable: true },
  { sport: "basketball", year: 1986, brand: "Fleer", setName: "Fleer", cardNumber: "26", player: "Patrick Ewing", team: "New York Knicks", isRookie: true, rarityTier: "key", rarityNotes: "Rookie card from the same set as the Jordan rookie.", low: 2000, high: 6000, gradable: true },
  { sport: "basketball", year: 1989, brand: "Hoops", setName: "Hoops", cardNumber: "138", player: "David Robinson", team: "San Antonio Spurs", isRookie: true, rarityTier: "minor_star", rarityNotes: "Rookie card from a huge print run.", low: 200, high: 600 },
  { sport: "basketball", year: 1990, brand: "Hoops", setName: "Hoops", cardNumber: "65", player: "Michael Jordan", team: "Chicago Bulls", rarityTier: "star", rarityNotes: "Base card of Jordan, printed in very large numbers.", low: 300, high: 800 },
  { sport: "basketball", year: 1990, brand: "Fleer", setName: "Fleer", cardNumber: "26", player: "Michael Jordan", team: "Chicago Bulls", rarityTier: "star", rarityNotes: "Base card of Jordan, printed in very large numbers.", low: 300, high: 800 },
  { sport: "basketball", year: 1990, brand: "Hoops", setName: "Hoops", cardNumber: "1", player: "Moses Malone", team: "Atlanta Hawks", rarityTier: "common", low: 10, high: 50 },
  { sport: "basketball", year: 1991, brand: "Fleer", setName: "Fleer", cardNumber: "1", player: "John Battle", team: "Atlanta Hawks", rarityTier: "common", low: 3, high: 15 },
  // Football
  { sport: "football", year: 1984, brand: "Topps", setName: "Topps", cardNumber: "63", player: "John Elway", team: "Denver Broncos", isRookie: true, rarityTier: "key", rarityNotes: "Elway's main rookie card.", low: 3000, high: 8000, gradable: true },
  { sport: "football", year: 1986, brand: "Topps", setName: "Topps", cardNumber: "161", player: "Jerry Rice", team: "San Francisco 49ers", isRookie: true, rarityTier: "key", rarityNotes: "Rice's rookie card. Green borders show chipping easily.", low: 4000, high: 12000, gradable: true },
  { sport: "football", year: 1989, brand: "Score", setName: "Score", cardNumber: "257", player: "Barry Sanders", team: "Detroit Lions", isRookie: true, rarityTier: "star", rarityNotes: "Popular rookie card; the borders are prone to chipping.", low: 1000, high: 3000, gradable: true },
  { sport: "football", year: 1990, brand: "Score", setName: "Score", cardNumber: "1", player: "Joe Montana", team: "San Francisco 49ers", rarityTier: "minor_star", low: 25, high: 100 },
  { sport: "football", year: 1990, brand: "Pro Set", setName: "Pro Set", cardNumber: "1", player: "Barry Sanders", team: "Detroit Lions", variation: "Rookie of the Year", rarityTier: "common", low: 10, high: 50 },
  // Hockey
  { sport: "hockey", year: 1985, brand: "Topps", setName: "Topps", cardNumber: "9", player: "Mario Lemieux", team: "Pittsburgh Penguins", isRookie: true, rarityTier: "grail", rarityNotes: "Lemieux's rookie card. The O-Pee-Chee version is worth more.", low: 20000, high: 50000, gradable: true },
  { sport: "hockey", year: 1988, brand: "Topps", setName: "Topps", cardNumber: "66", player: "Brett Hull", team: "St. Louis Blues", isRookie: true, rarityTier: "star", rarityNotes: "Hull's rookie card.", low: 1000, high: 3000, gradable: true },
  { sport: "hockey", year: 1990, brand: "Upper Deck", setName: "Upper Deck", cardNumber: "356", player: "Jaromir Jagr", team: "Pittsburgh Penguins", isRookie: true, rarityTier: "minor_star", rarityNotes: "Rookie card from a huge print run.", low: 300, high: 800 },
  { sport: "hockey", year: 1990, brand: "Score", setName: "Score", cardNumber: "1", player: "Wayne Gretzky", team: "Los Angeles Kings", rarityTier: "minor_star", low: 50, high: 200 },
  { sport: "hockey", year: 1990, brand: "Pro Set", setName: "Pro Set", cardNumber: "1", player: "Ray Bourque", team: "Boston Bruins", rarityTier: "common", low: 10, high: 50 },
];

type SealedProduct = {
  sport: Sport;
  year: number;
  brand: string;
  setName: string;
  productType: ProductType;
  packCount: number | null;
  description: string;
  pullList: string[];
  low: number;
  high: number;
};

export const SAMPLE_SEALED: readonly SealedProduct[] = [
  { sport: "baseball", year: 1990, brand: "Topps", setName: "Topps", productType: "box", packCount: 36, description: "Wax box of 36 packs", pullList: ["1990 Topps #414 Frank Thomas rookie", "1990 Topps #414 Frank Thomas no name error (very rare)", "1990 Topps #1 Nolan Ryan", "Ken Griffey Jr. base card", "Sammy Sosa rookie", "Larry Walker rookie"], low: 1500, high: 3000 },
  { sport: "basketball", year: 1989, brand: "Fleer", setName: "Fleer", productType: "pack", packCount: 1, description: "Single wax pack", pullList: ["Michael Jordan base card", "Scottie Pippen base card", "Reggie Miller base card", "Hakeem Olajuwon base card", "Team sticker inserts"], low: 1000, high: 2500 },
  { sport: "football", year: 1991, brand: "Upper Deck", setName: "Upper Deck", productType: "factory_set", packCount: null, description: "Complete factory set", pullList: ["1991 Upper Deck #647 Brett Favre rookie", "Herman Moore rookie", "Ricky Watters rookie", "Barry Sanders base card", "Joe Montana base card"], low: 2000, high: 4000 },
  { sport: "baseball", year: 1987, brand: "Topps", setName: "Topps", productType: "rack_pack", packCount: 1, description: "Rack pack", pullList: ["1987 Topps #320 Barry Bonds rookie", "1987 Topps #170 Bo Jackson", "1987 Topps #420 Will Clark rookie", "Mark McGwire base card", "Rafael Palmeiro rookie"], low: 1000, high: 2000 },
  { sport: "hockey", year: 1990, brand: "Upper Deck", setName: "Upper Deck", productType: "box", packCount: 36, description: "Low series wax box of 36 packs", pullList: ["1990 Upper Deck #356 Jaromir Jagr rookie", "Mats Sundin rookie", "Wayne Gretzky base card", "Mario Lemieux base card", "Sergei Fedorov rookie"], low: 1500, high: 3000 },
  { sport: "baseball", year: 1988, brand: "Donruss", setName: "Donruss", productType: "box", packCount: 36, description: "Wax box of 36 packs", pullList: ["Mark Grace Rated Rookie", "Roberto Alomar Rated Rookie", "Tom Glavine rookie", "Mark McGwire base card", "Puzzle pieces and Diamond Kings"], low: 1200, high: 2500 },
];

type BulkLot = {
  sport: Sport;
  year: number;
  yearEnd: number;
  brand: string | null;
  description: string;
  containerType: string;
  estCount: number;
  countNote: string;
  pullList: string[];
  low: number;
  high: number;
};

export const SAMPLE_BULK: readonly BulkLot[] = [
  { sport: "baseball", year: 1988, yearEnd: 1991, brand: null, description: "Mostly 1988 to 1991 Topps and Donruss baseball commons", containerType: "800-count box", estCount: 800, countNote: "Assumed a full 800-count box.", pullList: ["1989 Upper Deck #1 Ken Griffey Jr.", "1990 Topps #414 Frank Thomas", "1989 Fleer #616 Billy Ripken error", "1988 Donruss Mark Grace Rated Rookie", "1990 Topps #1 Nolan Ryan", "1989 Donruss Randy Johnson Rated Rookie", "1990 Donruss Juan Gonzalez Rated Rookie", "1991 Topps Desert Shield parallels (gold logo)"], low: 300, high: 800 },
  { sport: "baseball", year: 1987, yearEnd: 1987, brand: "Topps", description: "1987 Topps baseball with wood borders", containerType: "3200-count box", estCount: 3200, countNote: "Assumed a full 3200-count box.", pullList: ["1987 Topps #320 Barry Bonds rookie", "1987 Topps #170 Bo Jackson", "1987 Topps #420 Will Clark rookie", "1987 Topps #366 Mark McGwire", "Rafael Palmeiro rookie", "Barry Larkin rookie", "Roger Clemens Record Breaker"], low: 1200, high: 3000 },
  { sport: "basketball", year: 1989, yearEnd: 1991, brand: "Hoops", description: "Mostly 1989 to 1991 NBA Hoops basketball", containerType: "shoebox", estCount: 500, countNote: "Assumed about 500 cards in a packed shoebox.", pullList: ["1989 Hoops #138 David Robinson rookie", "1990 Hoops #65 Michael Jordan", "Shawn Kemp rookie", "Gary Payton rookie", "1989 Hoops Michael Jordan", "Tim Hardaway rookie"], low: 300, high: 800 },
  { sport: "football", year: 1989, yearEnd: 1991, brand: null, description: "Mixed 1989 to 1991 Score, Pro Set and Topps football", containerType: "800-count box", estCount: 800, countNote: "Assumed a full 800-count box.", pullList: ["1989 Score #257 Barry Sanders rookie", "Troy Aikman rookie", "Deion Sanders rookie", "Emmitt Smith rookie", "1991 Upper Deck #647 Brett Favre rookie", "Thurman Thomas rookie"], low: 300, high: 800 },
  { sport: "hockey", year: 1990, yearEnd: 1992, brand: null, description: "Mostly 1990 to 1992 Upper Deck, Score and Pro Set hockey", containerType: "5000-count box", estCount: 5000, countNote: "Assumed a full 5000-count box.", pullList: ["1990 Upper Deck #356 Jaromir Jagr rookie", "Mats Sundin rookie", "Sergei Fedorov rookie", "Eric Lindros early cards", "Martin Brodeur rookie", "Pavel Bure rookie", "Wayne Gretzky inserts"], low: 1500, high: 4000 },
];

/** Deterministic number source fed by a sha256 seed. No Math.random. */
class SeededRandom {
  private counter = 0;
  constructor(private readonly seed: Buffer) {}

  /** A number from 0 (inclusive) to 1 (exclusive). */
  next(): number {
    const h = createHash("sha256").update(this.seed).update(String(this.counter++)).digest();
    return h.readUInt32BE(0) / 0x1_0000_0000;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length - 1)];
  }

  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

function hashPhotos(mode: string, hint: string, photos: readonly RecognitionPhoto[]): Buffer {
  const h = createHash("sha256").update(`mode:${mode}\nhint:${hint}\n`);
  photos.forEach((p, i) => h.update(`photo:${i}:${p.role}:`).update(p.data));
  return h.digest();
}

/** Finds a 4 digit year from 1950 to 2030 in the owner's hint. */
export function hintYear(hint: string | null | undefined): number | null {
  if (!hint) return null;
  for (const m of hint.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) {
    const year = Number(m[1]);
    if (year >= 1950 && year <= 2030) return year;
  }
  return null;
}

/** Entries that match the hint year first, then the rest, each group shuffled. */
function orderByHint<T>(list: readonly T[], year: number | null, matches: (entry: T, year: number) => boolean, rand: SeededRandom): T[] {
  if (year === null) return rand.shuffle(list);
  const preferred = list.filter((e) => matches(e, year));
  const others = list.filter((e) => !matches(e, year));
  return [...rand.shuffle(preferred), ...rand.shuffle(others)];
}

/** Roughly one in four picks is unsure, so the review queue has something in it. */
function sampleConfidence(rand: SeededRandom): number {
  const unsure = rand.next() < 0.25;
  const value = unsure ? 0.55 + rand.next() * 0.17 : 0.8 + rand.next() * 0.18;
  return Math.round(value * 100) / 100;
}

const CONDITION_CHOICES: readonly { condition: Condition; factor: number; notes: string }[] = [
  { condition: "very_good", factor: 0.35, notes: "Rounded corners and some edge wear." },
  { condition: "excellent", factor: 0.6, notes: "Light corner wear, centering a little off." },
  { condition: "near_mint", factor: 1, notes: "Corners look sharp, small centering shift." },
  { condition: "near_mint", factor: 1, notes: "Clean surface, edges look good." },
  { condition: "mint", factor: 1.3, notes: "Sharp corners, clean edges, well centered." },
];

function scaled(cents: number, factor: number): number {
  return Math.max(1, Math.round(cents * factor));
}

function cardItem(card: CatalogCard, rand: SeededRandom, sourceIndex: number, box: Box | null): RecognizedItem {
  const confidence = sampleConfidence(rand);
  const cond = rand.pick(CONDITION_CHOICES);
  const sharp = cond.condition === "near_mint" || cond.condition === "mint";
  const worthGrading = card.gradable ? sharp : false;
  const input: RecognizedItemInput = {
    kind: "card",
    confidence,
    sourceIndex,
    box,
    sport: card.sport,
    year: card.year,
    brand: card.brand,
    setName: card.setName,
    cardNumber: card.cardNumber,
    player: card.player,
    team: card.team,
    variation: card.variation ?? null,
    isRookie: card.isRookie ?? false,
    isError: card.isError ?? false,
    isParallel: card.isParallel ?? false,
    rarityTier: card.rarityTier,
    rarityNotes: card.rarityNotes ?? null,
    condition: cond.condition,
    conditionNotes: `Sample guess: ${cond.notes}`,
    worthGrading,
    gradingNotes: card.gradable
      ? sharp
        ? "Sample: valuable enough in high grade that grading could pay off if it is as sharp as it looks."
        : "Sample: the visible wear makes a high grade unlikely, so grading probably would not pay off."
      : "Sample: not valuable enough for grading fees to pay off.",
    notes: confidence < 0.8 ? `${SAMPLE_NOTE} Marked as unsure so it lands in the review queue.` : SAMPLE_NOTE,
    estimate: {
      lowCents: scaled(card.low, cond.factor),
      highCents: scaled(card.high, cond.factor),
      basis: `${SAMPLE_BASIS} Rough raw value for this card in ${cond.condition.replace("_", " ")} condition.`,
    },
  };
  return recognizedItemSchema.parse(input);
}

/** Lays out n boxes as a tidy grid with small gaps. */
export function gridBoxes(n: number): Box[] {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = 0.02;
  const w = (1 - gap * (cols + 1)) / cols;
  const h = (1 - gap * (rows + 1)) / rows;
  const round = (v: number) => Math.floor(v * 10_000) / 10_000;
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return { x: round(gap + c * (w + gap)), y: round(gap + r * (h + gap)), w: round(w), h: round(h) };
  });
}

export class SampleRecognizer implements Recognizer {
  readonly name = "sample";

  async recognize(request: RecognitionRequest): Promise<RecognizedItem[]> {
    checkPhotoCount(request);
    const hint = request.hint ?? "";
    const year = hintYear(hint);
    const seed = hashPhotos(request.mode, hint, request.photos);
    const rand = new SeededRandom(seed);
    const cardMatches = (c: CatalogCard, y: number) => c.year === y;

    switch (request.mode) {
      case "single": {
        const card = orderByHint(SAMPLE_CARDS, year, cardMatches, rand)[0];
        return [cardItem(card, rand, 0, null)];
      }
      case "multi": {
        const sources = request.photos
          .map((p, index) => ({ p, index }))
          .filter(({ p }) => p.role === "source");
        const targets = sources.length > 0 ? sources : request.photos.map((p, index) => ({ p, index }));
        const items: RecognizedItem[] = [];
        for (const { index } of targets) {
          const photoRand = new SeededRandom(createHash("sha256").update(seed).update(`source:${index}`).digest());
          const count = photoRand.int(4, 9);
          const cards = orderByHint(SAMPLE_CARDS, year, cardMatches, photoRand).slice(0, count);
          const boxes = gridBoxes(count);
          cards.forEach((card, i) => items.push(cardItem(card, photoRand, index, boxes[i])));
        }
        return items;
      }
      case "sealed": {
        const product = orderByHint(SAMPLE_SEALED, year, (s, y) => s.year === y, rand)[0];
        const confidence = sampleConfidence(rand);
        const sealState: SealState = rand.next() < 0.75 ? "factory_sealed" : "unknown";
        return [recognizedItemSchema.parse({
          kind: "sealed",
          confidence,
          sourceIndex: 0,
          box: null,
          sport: product.sport,
          year: product.year,
          brand: product.brand,
          setName: product.setName,
          productType: product.productType,
          packCount: product.packCount,
          sealState,
          description: product.description,
          pullList: product.pullList,
          rarityTier: "common",
          notes: sealState === "unknown"
            ? `${SAMPLE_NOTE} The wrap could not be judged, so the seal is marked unknown.`
            : SAMPLE_NOTE,
          estimate: {
            lowCents: product.low,
            highCents: product.high,
            basis: `${SAMPLE_BASIS} Rough value of this product still sealed.`,
          },
        } satisfies RecognizedItemInput)];
      }
      case "bulk": {
        const lot = orderByHint(SAMPLE_BULK, year, (b, y) => y >= b.year && y <= b.yearEnd, rand)[0];
        const confidence = sampleConfidence(rand);
        const pulls = rand.shuffle(lot.pullList).slice(0, rand.int(5, Math.min(8, lot.pullList.length)));
        return [recognizedItemSchema.parse({
          kind: "bulk",
          confidence,
          sourceIndex: 0,
          box: null,
          sport: lot.sport,
          year: lot.year,
          yearEnd: lot.yearEnd,
          brand: lot.brand,
          estCount: lot.estCount,
          containerType: lot.containerType,
          description: lot.description,
          pullList: pulls,
          notes: `${SAMPLE_NOTE} ${lot.countNote}`,
          estimate: {
            lowCents: lot.low,
            highCents: lot.high,
            basis: `${SAMPLE_BASIS} Rough value of the whole lot sold as bulk commons.`,
          },
        } satisfies RecognizedItemInput)];
      }
    }
  }
}
