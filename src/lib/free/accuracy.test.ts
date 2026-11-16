import { describe, expect, it } from "vitest";
import { REVIEW_THRESHOLD, type RecognitionPhoto, type RecognizedItem } from "@/lib/recognition/types";
import type { OcrResult, TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";
import type { PlayerFacts } from "./wikidata";

/**
 * Realistic, noisy text as the reader returns it from real card photos:
 * stray marks, letters read as digits, bios that mention draft picks, and
 * copyright lines that name the parent company. Each case is one regression.
 */

/** [text, y, x, w, h, confidence] */
type Row = [string, number?, number?, number?, number?, number?];

function ocr(rows: Row[]): OcrResult {
  const lines = rows.map(([text, y = 0.5, x = 0.1, w = 0.8, h = 0.03, confidence = 0.8]) => ({ text, confidence, box: { x, y, w, h } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: lines.length ? 0.78 : 0 };
}

function readerFor(pages: Record<number, OcrResult>): TextReader {
  return { read: async (image: Buffer) => pages[image[0]] ?? { text: "", lines: [], confidence: 0 } };
}

const photo = (id: number, role: RecognitionPhoto["role"]): RecognitionPhoto => ({ role, data: Buffer.from([id, 0, 0]), width: 1000, height: 1400 });

type Case = {
  name: string;
  front?: Row[];
  back?: Row[];
  facts?: PlayerFacts;
  check: (item: RecognizedItem) => void;
};

const gooden: PlayerFacts = {
  name: "Dwight Gooden", wikidataId: "Q5", description: "American baseball player", sports: ["baseball"],
  teams: ["New York Mets"], careerStart: 1984, careerEnd: 2000, hallOfFame: false, birthYear: 1964,
};
const carter: PlayerFacts = {
  name: "Joe Carter", wikidataId: "Q6", description: "American baseball player", sports: ["baseball"],
  teams: ["San Diego Padres"], careerStart: 1983, careerEnd: 1998, hallOfFame: false, birthYear: 1960,
};

const CASES: Case[] = [
  {
    name: "1980 Topps #140 Rich Gale is not the Ray Bourque hockey card",
    back: [
      ["140", 0.04, 0.86, 0.08, 0.04, 0.82],
      ["RICH GALE", 0.07, 0.25, 0.4, 0.04, 0.8],
      ["HT: 6'7\" WT: 225 BATS: RIGHT", 0.12, 0.1, 0.8, 0.03, 0.6],
      ["© 1980 TOPPS CHEWING GUM, INC. PRTD. IN U.S.A.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.player).toBe("Rich Gale");
      expect(i.cardNumber).toBe("140");
      expect(i.sport).not.toBe("hockey");
      expect(i.rarityTier).toBeNull();
    },
  },
  {
    name: "a 1989 Upper Deck bio with 'the No. 1 pick' is not the Griffey #1",
    back: [
      ["723", 0.03, 0.88, 0.06, 0.04, 0.85],
      ["GREGG OLSON", 0.06, 0.2, 0.5, 0.05, 0.85],
      ["Gregg was the Orioles' No. 1 pick in the June 1988 draft", 0.5, 0.1, 0.8, 0.03, 0.6],
      ["©1989 THE UPPER DECK CO. PRINTED IN U.S.A.", 0.96, 0.1, 0.8, 0.02, 0.75],
    ],
    check: (i) => {
      expect(i.player).toBe("Gregg Olson");
      expect(i.cardNumber).toBe("723");
      expect(i.rarityTier).toBeNull();
    },
  },
  {
    name: "a bio line 'the No. 1 pick' with no corner number still is not #1",
    back: [
      ["GREGG OLSON", 0.06, 0.2, 0.5, 0.05, 0.85],
      ["No. 1 pick of the Orioles in 1988", 0.5, 0.1, 0.8, 0.03, 0.6],
      ["©1989 THE UPPER DECK CO.", 0.96, 0.1, 0.8, 0.02, 0.75],
    ],
    check: (i) => {
      expect(i.cardNumber).toBeNull();
      expect(i.player).toBe("Gregg Olson");
      expect(i.rarityTier).toBeNull();
    },
  },
  {
    name: "1985 Topps #3 Gooden Record Breaker is not the #620 rookie",
    back: [
      ["3", 0.03, 0.06, 0.04, 0.04, 0.8],
      ["RECORD BREAKER", 0.06, 0.25, 0.5, 0.04, 0.8],
      ["DWIGHT GOODEN", 0.1, 0.25, 0.5, 0.04, 0.8],
      ["© 1985 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    facts: gooden,
    check: (i) => {
      expect(i.cardNumber).toBe("3");
      expect(i.isRookie).toBe(false);
      expect(i.player).toBe("Dwight Gooden");
    },
  },
  {
    name: "a 1990 Donruss back with a Leaf, Inc. copyright is not 1990 Leaf #300 Thomas",
    back: [
      ["300", 0.04, 0.05, 0.08, 0.04, 0.8],
      ["JOE CARTER", 0.07, 0.3, 0.4, 0.04, 0.8],
      ["© 1990 LEAF, INC. PRINTED IN U.S.A.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    facts: carter,
    check: (i) => {
      expect(i.player).toBe("Joe Carter");
      expect(i.brand).not.toBe("Leaf");
      expect(i.rarityTier).toBeNull();
      expect(i.notes).toMatch(/Leaf, Inc\./);
    },
  },
  {
    name: "a draft line does not beat the corner number",
    back: [
      ["DRAFTED: WHITE SOX #1, JUNE 1987", 0.02, 0.1, 0.8, 0.03, 0.7],
      ["512", 0.04, 0.88, 0.07, 0.04, 0.85],
      ["JACK MCDOWELL", 0.07, 0.25, 0.5, 0.04, 0.85],
      ["© 1989 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i.cardNumber).toBe("512"),
  },
  {
    name: "a draft marker in text with no corner number is ignored",
    back: [
      ["JACK MCDOWELL", 0.07, 0.25, 0.5, 0.04, 0.85],
      ["Drafted #1 by the White Sox in June 1987", 0.4, 0.1, 0.8, 0.03, 0.7],
      ["© 1989 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i.cardNumber).toBeNull(),
  },
  {
    name: "1989 Fleer #616 Bill Ripken is not filed as the error card",
    back: [
      ["616", 0.04, 0.85, 0.08, 0.04, 0.8],
      ["BILL RIPKEN", 0.07, 0.25, 0.4, 0.04, 0.8],
      ["© 1989 FLEER CORP. PRINTED IN U.S.A.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.player).toBe("Bill Ripken");
      expect(i.isError).toBe(false);
      expect(i.notes).toMatch(/Check whether this is the error version/);
      expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD);
    },
  },
  {
    name: "1989 Upper Deck #357 Dale Murphy is not filed as the reverse negative",
    back: [
      ["357", 0.03, 0.88, 0.06, 0.04, 0.85],
      ["DALE MURPHY", 0.06, 0.2, 0.5, 0.05, 0.85],
      ["©1989 THE UPPER DECK CO.", 0.96, 0.1, 0.8, 0.02, 0.75],
    ],
    check: (i) => {
      expect(i.isError).toBe(false);
      expect(i.variation).toBeNull();
      expect(i.notes).toMatch(/Check whether this is the error version: Reverse negative/);
      expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD);
    },
  },
  {
    name: "1990 Topps #414 Frank Thomas from the back only: matched, and the no name error is left to the owner",
    back: [
      ["N0. 4l4", 0.04, 0.05, 0.2, 0.04, 0.6],
      ["FRANK THOMAS", 0.08, 0.3, 0.5, 0.04, 0.85],
      ["© 1990 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.8, 0.02, 0.8],
    ],
    check: (i) => {
      expect(i).toMatchObject({ player: "Frank Thomas", cardNumber: "414", isRookie: true, isError: false, rarityTier: "key" });
      expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD);
      expect(i.notes).toMatch(/Check whether this is the error version: No name on front/);
    },
  },
  {
    name: "Major League Marketing means Score",
    back: [
      ["NO. 623", 0.03, 0.05, 0.2, 0.04, 0.8],
      ["TODD FROHWIRTH", 0.07, 0.3, 0.5, 0.04, 0.8],
      ["(C) 1988 MAJOR LEAGUE MARKETING, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i).toMatchObject({ year: 1988, brand: "Score" }),
  },
  {
    name: "NBA Properties with a year means NBA Hoops and finds David Robinson",
    back: [
      ["138", 0.03, 0.88, 0.07, 0.04, 0.8],
      ["DAVID ROBINSON", 0.07, 0.3, 0.5, 0.04, 0.8],
      ["CENTER", 0.11, 0.3, 0.2, 0.03, 0.8],
      ["© 1989 NBA PROPERTIES, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i).toMatchObject({ year: 1989, brand: "NBA Hoops", player: "David Robinson", isRookie: true });
      expect(i.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    },
  },
  {
    name: "F1EER is Fleer",
    back: [
      ["57", 0.04, 0.08, 0.08, 0.04, 0.9],
      ["MICHAEL JORDAN", 0.05, 0.3, 0.5, 0.04, 0.85],
      ["© 1986 F1EER CORP. PRINTED IN U.S.A.", 0.95, 0.1, 0.8, 0.02, 0.6],
    ],
    check: (i) => expect(i).toMatchObject({ brand: "Fleer", year: 1986, player: "Michael Jordan", cardNumber: "57" }),
  },
  {
    name: "a traded number read as '98 T'",
    back: [
      ["98 T", 0.03, 0.82, 0.12, 0.04, 0.8],
      ["CAL RIPKEN JR.", 0.08, 0.3, 0.5, 0.04, 0.8],
      ["© 1982 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i).toMatchObject({ cardNumber: "98T", setName: "Topps Traded", player: "Cal Ripken Jr." }),
  },
  {
    name: "a two digit year on a front: Donruss '87",
    front: [
      ["Donruss '87", 0.04, 0.05, 0.3, 0.04, 0.7],
      ["GREG MADDUX", 0.9, 0.1, 0.5, 0.05, 0.85],
    ],
    check: (i) => expect(i).toMatchObject({ year: 1987, brand: "Donruss" }),
  },
  {
    name: "a two digit year before the brand: '89 Fleer",
    front: [
      ["'89 Fleer", 0.04, 0.05, 0.3, 0.04, 0.7],
      ["JOE SAMPLE", 0.9, 0.1, 0.5, 0.05, 0.85],
    ],
    check: (i) => expect(i).toMatchObject({ year: 1989, brand: "Fleer" }),
  },
  {
    name: "a school name is not a player",
    back: [
      ["OKLAHOMA STATE", 0.03, 0.3, 0.4, 0.04, 0.85],
      ["THURMAN THOMAS", 0.07, 0.3, 0.5, 0.05, 0.85],
      ["© 1988 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.player).toBe("Thurman Thomas");
      expect(i.notes ?? "").not.toMatch(/Oklahoma State/);
    },
  },
  {
    name: "a slab label with a grade and no grader name",
    front: [["1989 UPPER DECK #1 KEN GRIFFEY JR. GEM MT 10", 0.05, 0.05, 0.9, 0.04, 0.8]],
    check: (i) => expect(i).toMatchObject({ grade: "10", grader: null, player: "Ken Griffey Jr." }),
  },
  {
    name: "a key number with no name read is only a possible match",
    back: [
      ["57", 0.04, 0.08, 0.08, 0.04, 0.9],
      ["© 1986 FLEER CORP.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD);
      expect(i.notes).toMatch(/Possible match: 1986 Fleer #57 Michael Jordan/);
    },
  },
  {
    name: "Wikidata alone does not lift a card with no number over the review line",
    back: [
      ["DWIGHT GOODEN", 0.1, 0.25, 0.5, 0.04, 0.8],
      ["© 1987 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    facts: gooden,
    check: (i) => expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD),
  },
  {
    name: "year, brand, number and a Wikidata player passes review but stays at 0.8 or less",
    back: [
      ["130", 0.04, 0.88, 0.07, 0.04, 0.85],
      ["DWIGHT GOODEN", 0.1, 0.25, 0.5, 0.04, 0.8],
      ["© 1987 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    facts: gooden,
    check: (i) => {
      expect(i.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
      expect(i.confidence).toBeLessThanOrEqual(0.8);
    },
  },
  {
    name: "1986 Topps Steve Young is not his rookie card",
    back: [
      ["374", 0.04, 0.88, 0.07, 0.04, 0.85],
      ["STEVE YOUNG", 0.08, 0.3, 0.5, 0.04, 0.85],
      ["QUARTERBACK", 0.12, 0.3, 0.3, 0.03, 0.8],
      ["© 1986 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.player).toBe("Steve Young");
      expect(i.isRookie).toBe(false);
    },
  },
  {
    name: "1986 Fleer Jordan notes the earlier Star card",
    back: [
      ["57", 0.04, 0.08, 0.08, 0.04, 0.9],
      ["MICHAEL JORDAN", 0.05, 0.3, 0.5, 0.04, 0.85],
      ["GUARD", 0.09, 0.3, 0.2, 0.03, 0.8],
      ["© 1986 FLEER CORP.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      // Collectors count the 1986 Fleer card as Jordan's rookie card.
      expect(i).toMatchObject({ player: "Michael Jordan", isRookie: true, rarityTier: "grail" });
      expect(i.rarityNotes).toMatch(/earlier Star Company card exists/);
    },
  },
  {
    name: "the key name with no number read is only a possible match",
    back: [
      ["DON MATTINGLY", 0.07, 0.3, 0.5, 0.04, 0.85],
      ["© 1984 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => {
      expect(i.player).toBe("Don Mattingly");
      expect(i.confidence).toBeLessThan(REVIEW_THRESHOLD);
      expect(i.notes).toMatch(/Possible match: 1984 Topps #8 Don Mattingly/);
    },
  },
  {
    name: "a weak front only read tells the owner to add the back",
    front: [["J0E SAMPLE", 0.9, 0.1, 0.5, 0.05, 0.4]],
    check: (i) => expect(i.notes).toMatch(/Add a photo of the back; the year and number are usually there\./),
  },
  {
    name: "a sport read from the card blocks a key card of another sport",
    back: [
      ["482", 0.04, 0.88, 0.07, 0.04, 0.85],
      ["NATIONAL HOCKEY LEAGUE", 0.5, 0.1, 0.8, 0.03, 0.7],
      ["© 1980 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i.rarityTier).toBeNull(),
  },
  {
    name: "Ryne Sandberg 1983 Topps #83 is on the list",
    back: [
      ["83", 0.04, 0.88, 0.07, 0.04, 0.85],
      ["RYNE SANDBERG", 0.08, 0.3, 0.5, 0.04, 0.85],
      ["© 1983 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i).toMatchObject({ rarityTier: "key", isRookie: true }),
  },
  {
    name: "1990 Topps Griffey back from a phone photo: the name comes from the header, never the bio",
    back: [
      ["4 Ken Griffey, Jr.\u00ae OF", 0.05, 0.12, 0.67, 0.1, 0.57],
      ["87 BELLINGHAM", 0.31, 0.12, 0.2, 0.03, 0.85],
      ["88 SN BERNARDINO", 0.35, 0.12, 0.2, 0.03, 0.87],
      ["88 VERMONT", 0.4, 0.12, 0.2, 0.03, 0.9],
      ["89 MARMNERS", 0.44, 0.12, 0.2, 0.03, 0.71],
      ["Ken graduated from Moeller (Cincinnati) High School", 0.56, 0.15, 0.7, 0.04, 0.96],
      ["in 1987. He played 3 years of football and 4 years", 0.62, 0.15, 0.7, 0.04, 0.95],
    ],
    check: (i) => {
      expect(i.player).toBe("Ken Griffey Jr.");
      expect(i).toMatchObject({ year: 1990, team: "Seattle Mariners", sport: "baseball", cardNumber: null });
    },
  },
  {
    name: "a bio that starts with a first name is not the player",
    back: [
      ["BO JACKSON", 0.06, 0.2, 0.5, 0.05, 0.85],
      ["Bo played football at Auburn", 0.5, 0.1, 0.8, 0.03, 0.8],
      ["Vincent Edward Jackson was drafted by the Royals.", 0.55, 0.1, 0.8, 0.03, 0.8],
      ["\u00a9 1990 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.8, 0.02, 0.7],
    ],
    check: (i) => expect(i.player).toBe("Bo Jackson"),
  },
];

describe("realistic noisy card text", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const pages: Record<number, OcrResult> = {};
      const photos: RecognitionPhoto[] = [];
      // A front photo is always sent; a blank one reads as no text.
      pages[1] = ocr(c.front ?? []);
      photos.push(photo(1, "front"));
      if (c.back) {
        pages[2] = ocr(c.back);
        photos.push(photo(2, "back"));
      }
      const r = new FreeRecognizer({ reader: readerFor(pages), lookup: async () => c.facts ?? null });
      const [item] = await r.recognize({ mode: "single", photos });
      c.check(item);
    });
  }
});
