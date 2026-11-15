import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText, parseProductText, type ParsedCard } from "./parse";

/** [text, y, x, w, h, confidence] with sensible defaults. */
type Row = [string, number?, number?, number?, number?, number?];

function ocr(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y = 0.5, x = 0.1, w = 0.8, h = 0.03, confidence = 0.8]) => ({
    text,
    confidence,
    box: { x, y, w, h },
  }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.75 };
}

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

function noDashes(p: { evidence: string[] }) {
  for (const e of p.evidence) expect(e).not.toMatch(DASHES);
}

const thomasFront = ocr([
  ["FRANK THOMAS", 0.88, 0.1, 0.6, 0.06, 0.9],
  ["WHITE SOX", 0.94, 0.6, 0.3, 0.03, 0.85],
]);

const thomasBack = ocr([
  ["NO. 414", 0.04, 0.05, 0.2, 0.04, 0.9],
  ["FRANK THOMAS", 0.08, 0.3, 0.5, 0.04, 0.85],
  ["1B CHICAGO WHITE SOX", 0.12, 0.3, 0.5, 0.03, 0.8],
  ["HT: 6'5\" WT: 240 BATS: RIGHT THROWS: RIGHT", 0.16, 0.1, 0.8, 0.03, 0.7],
  ["DRAFTED: WHITE SOX #1, JUNE 1989", 0.2, 0.1, 0.8, 0.03, 0.7],
  ["BORN: 5-27-68, COLUMBUS, GA. HOME: COLUMBUS, GA.", 0.24, 0.1, 0.8, 0.03, 0.6],
  ["COMPLETE MINOR LEAGUE BATTING RECORD", 0.3, 0.1, 0.8, 0.03, 0.8],
  ["YEAR CLUB G AB R H 2B 3B HR RBI AVG", 0.34, 0.1, 0.8, 0.03, 0.7],
  ["1989 Sarasota 55 188 27 52 9 1 4 30 .277", 0.38, 0.1, 0.8, 0.03, 0.7],
  ["1989 Birmingham 17 56 8 13 0 0 1 4 .232", 0.42, 0.1, 0.8, 0.03, 0.7],
  ["Frank was the White Sox top pick in the June 1989 draft and the 7th player taken overall", 0.6, 0.1, 0.8, 0.03, 0.6],
  ["© 1990 THE TOPPS COMPANY, INC. PRINTED IN U.S.A.", 0.95, 0.1, 0.8, 0.02, 0.8],
]);

const griffeyBack = ocr([
  ["1", 0.03, 0.88, 0.05, 0.04, 0.9],
  ["KEN GRIFFEY JR.", 0.06, 0.2, 0.5, 0.05, 0.85],
  ["Seattle Mariners OF", 0.11, 0.2, 0.5, 0.03, 0.8],
  ["Ht: 6-3 Wt: 195 Bats: Left Throws: Left", 0.15, 0.2, 0.6, 0.03, 0.7],
  ["Born: 11-21-69, Donora, Pa.", 0.19, 0.2, 0.6, 0.03, 0.7],
  ["YR CLUB AVG G AB R H HR RBI SB", 0.6, 0.1, 0.8, 0.03, 0.7],
  ["87 Bellingham .313 54 182 43 57 14 40 13", 0.64, 0.1, 0.8, 0.03, 0.7],
  ["88 San Bernardino .338 58 219 50 74 11 42 32", 0.68, 0.1, 0.8, 0.03, 0.7],
  ["88 Vermont .279 17 61 10 17 2 10 4", 0.72, 0.1, 0.8, 0.03, 0.7],
  ["©1989 THE UPPER DECK CO. PRINTED IN U.S.A.", 0.96, 0.1, 0.8, 0.02, 0.75],
]);

const griffeyFront = ocr([
  ["Upper Deck", 0.04, 0.05, 0.3, 0.04, 0.7],
  ["Ken Griffey, Jr.", 0.9, 0.1, 0.5, 0.05, 0.85],
]);

const jordanFront = ocr([
  ["FLEER", 0.03, 0.05, 0.25, 0.05, 0.85],
  ["MICHAEL JORDAN", 0.85, 0.1, 0.6, 0.06, 0.9],
  ["BULLS", 0.92, 0.7, 0.2, 0.04, 0.85],
]);

const jordanBack = ocr([
  ["57", 0.04, 0.08, 0.08, 0.04, 0.9],
  ["MICHAEL JORDAN", 0.05, 0.3, 0.5, 0.04, 0.85],
  ["GUARD", 0.09, 0.3, 0.2, 0.03, 0.8],
  ["HEIGHT: 6-6 WEIGHT: 195 COLLEGE: NORTH CAROLINA", 0.13, 0.1, 0.8, 0.03, 0.7],
  ["YEAR TEAM G MIN FGM FGA PCT FTM FTA PCT REB AST PTS AVG", 0.5, 0.1, 0.8, 0.03, 0.7],
  ["84-85 CHICAGO 82 3144 837 1625 .515 630 746 .845 534 481 2313 28.2", 0.55, 0.1, 0.8, 0.03, 0.7],
  ["85-86 CHICAGO 18 451 150 328 .457 105 125 .840 64 53 408 22.7", 0.6, 0.1, 0.8, 0.03, 0.7],
]);

describe("parseCardText", () => {
  it("reads a 1990 Topps Frank Thomas back and front", () => {
    const p = parseCardText(thomasFront, thomasBack);
    expect(p.year).toBe(1990);
    expect(p.brand).toBe("Topps");
    expect(p.setName).toBe("Topps");
    expect(p.cardNumber).toBe("414");
    expect(p.playerCandidates[0]).toBe("Frank Thomas");
    expect(p.playerCandidates.length).toBeLessThanOrEqual(5);
    expect(p.team).toBe("Chicago White Sox");
    expect(p.sport).toBe("baseball");
    expect(p.position).toBe("1B");
    expect(p.grader).toBeNull();
    expect(p.grade).toBeNull();
    expect(p.certNumber).toBeNull();
    expect(p.serialNumber).toBeNull();
    expect(p.evidence).toContain("Read copyright line: 1990 Topps");
    expect(p.evidence).toContain("Read card number 414");
    noDashes(p);
  });

  it("does not read city names or card words as players", () => {
    const p = parseCardText(thomasFront, thomasBack);
    for (const n of p.playerCandidates) {
      expect(n).not.toMatch(/Chicago|White|Columbus|Topps|Minor|Batting/);
    }
  });

  it("reads a 1989 Upper Deck Griffey with the number in the top corner", () => {
    const p = parseCardText(griffeyFront, griffeyBack);
    expect(p.year).toBe(1989);
    expect(p.brand).toBe("Upper Deck");
    expect(p.setName).toBe("Upper Deck");
    expect(p.cardNumber).toBe("1");
    expect(p.playerCandidates[0]).toBe("Ken Griffey Jr.");
    expect(p.team).toBe("Seattle Mariners");
    expect(p.sport).toBe("baseball");
    expect(p.position).toBe("OF");
    expect(p.evidence).toContain("Read copyright line: 1989 Upper Deck");
    expect(p.evidence).toContain("Name matches the key card list: Ken Griffey Jr.");
    noDashes(p);
  });

  it("reads a 1986 Fleer Jordan year from the stat table", () => {
    const p = parseCardText(jordanFront, jordanBack);
    expect(p.year).toBe(1986);
    expect(p.brand).toBe("Fleer");
    expect(p.setName).toBe("Fleer");
    expect(p.cardNumber).toBe("57");
    expect(p.playerCandidates[0]).toBe("Michael Jordan");
    expect(p.team).toBe("Chicago Bulls");
    expect(p.sport).toBe("basketball");
    expect(p.position).toBe("G");
    expect(p.evidence.some((e) => e.includes("stat table ending with 1985"))).toBe(true);
    noDashes(p);
  });

  it("copes with OCR noise in the year, brand and number", () => {
    const back = ocr([
      ["N0. 4l4", 0.04, 0.05, 0.2, 0.04, 0.6],
      ["FRANK THOMAS", 0.08, 0.3, 0.5, 0.04, 0.7],
      ["©1g89 T0PPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02, 0.5],
    ]);
    const p = parseCardText(null, back);
    expect(p.year).toBe(1989);
    expect(p.brand).toBe("Topps");
    expect(p.cardNumber).toBe("414");
    expect(p.playerCandidates[0]).toBe("Frank Thomas");
  });

  it("fixes OCR digits inside a name in capitals", () => {
    const p = parseCardText(ocr([["KEN GR1FFEY JR.", 0.9, 0.1, 0.5, 0.05]]), null);
    expect(p.playerCandidates[0]).toBe("Ken Griffey Jr.");
  });

  it("does not fix digits in a year with no copyright mark or brand next to it", () => {
    const p = parseCardText(null, ocr([["Drafted in 1g89 by the Sox", 0.5]]));
    expect(p.year).toBeNull();
  });

  it("reads a front only scan with a name and team", () => {
    const p = parseCardText(
      ocr([
        ["Mark McGwire", 0.1, 0.1, 0.6, 0.06, 0.9],
        ["ATHLETICS", 0.9, 0.6, 0.3, 0.04, 0.8],
      ]),
      null,
    );
    expect(p.playerCandidates[0]).toBe("Mark McGwire");
    expect(p.team).toBe("Oakland Athletics");
    expect(p.sport).toBe("baseball");
    expect(p.year).toBeNull();
    expect(p.brand).toBeNull();
    expect(p.setName).toBeNull();
    expect(p.cardNumber).toBeNull();
  });

  it("title cases names with apostrophes and leaves an unclear team without a sport", () => {
    const p = parseCardText(ocr([["SHAQUILLE O'NEAL", 0.1, 0.1, 0.6, 0.06], ["KINGS", 0.9]]), null);
    expect(p.playerCandidates[0]).toBe("Shaquille O'Neal");
    expect(p.team).toBe("Kings");
    expect(p.sport).toBeNull();
    expect(p.evidence.some((e) => e.includes("more than one sport"))).toBe(true);
  });

  it("settles a shared team name with other clues", () => {
    const hockey = parseCardText(ocr([["WAYNE GRETZKY", 0.1], ["KINGS", 0.9], ["C", 0.95, 0.8, 0.1]]), ocr([["NATIONAL HOCKEY LEAGUE", 0.9]]));
    expect(hockey.team).toBe("Los Angeles Kings");
    expect(hockey.sport).toBe("hockey");
    const texas = parseCardText(ocr([["NOLAN RYAN", 0.1], ["TEXAS RANGERS", 0.9]]), null);
    expect(texas.team).toBe("Texas Rangers");
    expect(texas.sport).toBe("baseball");
    const ny = parseCardText(ocr([["BRIAN LEETCH", 0.1], ["NEW YORK RANGERS", 0.9]]), null);
    expect(ny.team).toBe("New York Rangers");
    expect(ny.sport).toBe("hockey");
  });

  it("reads a PSA slab label", () => {
    const p = parseCardText(
      ocr([
        ["1989 UPPER DECK #1 KEN GRIFFEY JR. MINT 9 12345678", 0.05, 0.05, 0.9, 0.04, 0.8],
        ["PSA", 0.05, 0.85, 0.1, 0.04, 0.7],
      ]),
      null,
    );
    expect(p.year).toBe(1989);
    expect(p.brand).toBe("Upper Deck");
    expect(p.setName).toBe("Upper Deck");
    expect(p.cardNumber).toBe("1");
    expect(p.playerCandidates[0]).toBe("Ken Griffey Jr.");
    expect(p.grader).toBe("PSA");
    expect(p.grade).toBe("9");
    expect(p.certNumber).toBe("12345678");
    expect(p.evidence).toContain("Read graded holder label: PSA 9, cert 12345678");
    noDashes(p);
  });

  it("reads half grades and a slab label with no grader name", () => {
    const bgs = parseCardText(ocr([["BGS NM-MT 8.5 0012345678"], ["1986 FLEER #57 MICHAEL JORDAN"]]), null);
    expect(bgs.grader).toBe("BGS");
    expect(bgs.grade).toBe("8.5");
    expect(bgs.certNumber).toBe("0012345678");
    const plain = parseCardText(ocr([["1989 UPPER DECK #1 KEN GRIFFEY JR. GEM MT 10 87654321"]]), null);
    expect(plain.grader).toBeNull();
    expect(plain.grade).toBe("10");
    expect(plain.certNumber).toBe("87654321");
  });

  it("reads traded numbers and sets", () => {
    const p = parseCardText(null, ocr([["98T", 0.03, 0.85, 0.08, 0.04], ["CAL RIPKEN JR.", 0.08], ["© 1982 TOPPS CHEWING GUM, INC.", 0.95]]));
    expect(p.cardNumber).toBe("98T");
    expect(p.setName).toBe("Topps Traded");
    expect(p.playerCandidates[0]).toBe("Cal Ripken Jr.");
    const u = parseCardText(null, ocr([["NO. U-27", 0.03], ["© 1984 FLEER CORP.", 0.95]]));
    expect(u.cardNumber).toBe("U-27");
    expect(u.setName).toBe("Fleer Update");
  });

  it("reads Donruss from a Leaf, Inc. copyright line", () => {
    const p = parseCardText(null, ocr([["NO. 36", 0.03], ["©1987 Leaf, Inc.", 0.95]]));
    expect(p.year).toBe(1987);
    expect(p.brand).toBe("Donruss");
    const leaf = parseCardText(null, ocr([["NO. 300", 0.03], ["© 1990 LEAF, INC.", 0.95]]));
    expect(leaf.brand).toBe("Leaf");
  });

  it("reads brand variants and subsets", () => {
    expect(parseCardText(null, ocr([["(C) 1990 FLEER CORP", 0.95]])).year).toBe(1990);
    expect(parseCardText(null, ocr([["1991 Score", 0.95]])).brand).toBe("Score");
    expect(parseCardText(null, ocr([["© 1988 Donruss", 0.95]])).brand).toBe("Donruss");
    const sc = parseCardText(ocr([["STADIUM CLUB", 0.05]]), ocr([["© 1991 THE TOPPS COMPANY, INC.", 0.95]]));
    expect(sc.brand).toBe("Topps");
    expect(sc.setName).toBe("Stadium Club");
    const opc = parseCardText(null, ocr([["© O-PEE-CHEE CO. LTD. 1985", 0.95]]));
    expect(opc.brand).toBe("O-Pee-Chee");
    expect(opc.year).toBe(1985);
    expect(opc.sport).toBeNull();
    const hoops = parseCardText(ocr([["NBA HOOPS", 0.05]]), null);
    expect(hoops.brand).toBe("NBA Hoops");
    expect(hoops.sport).toBe("basketball");
  });

  it("reads a serial number but not a birth date", () => {
    expect(parseCardText(ocr([["045/100", 0.9]]), null).serialNumber).toBe("045/100");
    expect(parseCardText(ocr([["BORN 12/30/68", 0.9]]), null).serialNumber).toBeNull();
  });

  it("returns empty fields for empty or odd input and never throws", () => {
    const empty: ParsedCard = {
      year: null,
      brand: null,
      setName: null,
      cardNumber: null,
      playerCandidates: [],
      team: null,
      sport: null,
      position: null,
      grader: null,
      grade: null,
      certNumber: null,
      serialNumber: null,
      evidence: [],
    };
    expect(parseCardText(null, null)).toEqual(empty);
    expect(parseCardText({ text: "", lines: [], confidence: 0 }, { text: "", lines: [], confidence: 0 })).toEqual(empty);
    const junk = { text: 42, lines: [null, { text: 5 }, { text: "%%%%" }], confidence: "x" } as unknown as OcrResult;
    expect(() => parseCardText(junk, junk)).not.toThrow();
    expect(parseCardText(junk, junk).playerCandidates).toEqual([]);
  });

  it("falls back to plain text when there are no lines", () => {
    const p = parseCardText(null, { text: "NO. 57\n© 1986 FLEER CORP.", lines: [], confidence: 0.6 });
    expect(p.year).toBe(1986);
    expect(p.brand).toBe("Fleer");
    expect(p.cardNumber).toBe("57");
  });
});

describe("parseProductText", () => {
  it("reads a 1990 Topps wax box", () => {
    const p = parseProductText(ocr([["1990 TOPPS BASEBALL 36 PACKS WAX BOX", 0.5]]));
    expect(p.year).toBe(1990);
    expect(p.yearEnd).toBeNull();
    expect(p.brand).toBe("Topps");
    expect(p.setName).toBe("Topps");
    expect(p.sport).toBe("baseball");
    expect(p.productType).toBe("box");
    expect(p.packCount).toBe(36);
    expect(p.estCount).toBeNull();
    expect(p.containerType).toBeNull();
    noDashes(p);
  });

  it("reads a bulk 800 count box label with a year range", () => {
    const p = parseProductText(ocr([["800 COUNT", 0.2], ["1987-1991 DONRUSS", 0.6]]));
    expect(p.year).toBe(1987);
    expect(p.yearEnd).toBe(1991);
    expect(p.brand).toBe("Donruss");
    expect(p.setName).toBe("Donruss");
    expect(p.productType).toBeNull();
    expect(p.packCount).toBeNull();
    expect(p.estCount).toBe(800);
    expect(p.containerType).toBe("800 count box");
    expect(p.evidence).toContain("Read year range 1987 to 1991");
    noDashes(p);
  });

  it("reads other product words", () => {
    expect(parseProductText(ocr([["1988 FLEER BASEBALL RACK PACK"]])).productType).toBe("rack_pack");
    expect(parseProductText(ocr([["1989 SCORE FOOTBALL CELLO PACK"]])).productType).toBe("cello_pack");
    const fs = parseProductText(ocr([["1991 TOPPS FACTORY SET 792 CARDS"]]));
    expect(fs.productType).toBe("factory_set");
    expect(fs.estCount).toBe(792);
    const pack = parseProductText(ocr([["1986 FLEER BASKETBALL WAX PACK", 0.3], ["15 CARDS PER PACK", 0.6]]));
    expect(pack.productType).toBe("pack");
    expect(pack.estCount).toBeNull();
    expect(pack.sport).toBe("basketball");
    expect(parseProductText(ocr([["MONSTER BOX"], ["MIXED SPORTS"]])).containerType).toBe("Monster box");
    expect(parseProductText(ocr([["MONSTER BOX"], ["MIXED SPORTS"]])).sport).toBe("multi");
    expect(parseProductText(ocr([["3200 COUNT"]])).estCount).toBe(3200);
    expect(parseProductText(ocr([["1990-91 O-PEE-CHEE HOCKEY 48 PACKS"]])).year).toBe(1990);
  });

  it("returns empty fields for empty input and never throws", () => {
    const p = parseProductText({ text: "", lines: [], confidence: 0 });
    expect(p).toEqual({
      year: null,
      yearEnd: null,
      brand: null,
      setName: null,
      sport: null,
      productType: null,
      packCount: null,
      estCount: null,
      containerType: null,
      evidence: [],
    });
    expect(() => parseProductText(null as unknown as OcrResult)).not.toThrow();
  });
});
