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
    // From 1990 Leaf, Inc. made both brands, so the line alone settles nothing.
    const leafInc = parseCardText(null, ocr([["NO. 300", 0.03], ["© 1990 LEAF, INC.", 0.95]]));
    expect(leafInc.brand).toBeNull();
    expect(leafInc.year).toBe(1990);
    expect(leafInc.evidence.some((e) => e.includes("Leaf, Inc."))).toBe(true);
    const leaf = parseCardText(ocr([["Leaf", 0.04, 0.05, 0.2]]), ocr([["NO. 300", 0.03], ["© 1990 LEAF, INC.", 0.95]]));
    expect(leaf.brand).toBe("Leaf");
    const donruss = parseCardText(ocr([["Donruss '90", 0.04, 0.05, 0.3]]), ocr([["NO. 300", 0.03], ["© 1990 LEAF, INC.", 0.95]]));
    expect(donruss.brand).toBe("Donruss");
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
      firstNameHint: null,
      team: null,
      teamHint: null,
      teamHintSport: null,
      sport: null,
      position: null,
      grader: null,
      grade: null,
      certNumber: null,
      serialNumber: null,
      serialRead: null,
      rookieWord: false,
      isAutograph: false,
      isReprint: false,
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

describe("parseCardText regressions from real scans", () => {
  it("prefers the corner number and skips draft and pick markers", () => {
    const p = parseCardText(null, ocr([
      ["DRAFTED: WHITE SOX #1, JUNE 1989", 0.02, 0.1, 0.8, 0.03],
      ["414", 0.04, 0.86, 0.08, 0.04],
      ["\u00a9 1990 THE TOPPS COMPANY, INC.", 0.95],
    ]));
    expect(p.cardNumber).toBe("414");
    for (const line of ["the No. 1 pick in the 1987 draft", "his #1 draft choice", "No. 2 starter in the rotation", "a No. 3 selection overall", "1st round #4"]) {
      expect(parseCardText(null, ocr([[line, 0.4], ["\u00a9 1990 FLEER CORP.", 0.95]])).cardNumber).toBeNull();
    }
    expect(parseCardText(null, ocr([["1B", 0.03, 0.86, 0.06, 0.04], ["NO. 77", 0.06]])).cardNumber).toBe("77");
  });

  it("reads Major League Marketing as Score without calling it baseball", () => {
    const p = parseCardText(null, ocr([["(C) 1988 MAJOR LEAGUE MARKETING, INC.", 0.95]]));
    expect(p).toMatchObject({ brand: "Score", year: 1988, sport: null });
  });

  it("reads NBA Properties as NBA Hoops only when no other brand is read", () => {
    expect(parseCardText(null, ocr([["\u00a9 1990 NBA PROPERTIES, INC.", 0.95]]))).toMatchObject({ brand: "NBA Hoops", year: 1990, sport: "basketball" });
    const fleer = parseCardText(null, ocr([["\u00a9 1990 FLEER CORP.", 0.93], ["\u00a9 1990 NBA PROPERTIES, INC.", 0.95]]));
    expect(fleer.brand).toBe("Fleer");
  });

  it("reads F1EER, a split traded number and two digit years", () => {
    expect(parseCardText(null, ocr([["\u00a9 1987 F1EER CORP.", 0.95]])).brand).toBe("Fleer");
    expect(parseCardText(null, ocr([["NO. 70 T", 0.03], ["\u00a9 1987 TOPPS CHEWING GUM, INC.", 0.95]])).cardNumber).toBe("70T");
    expect(parseCardText(ocr([["Donruss \u201987", 0.04]]), null).year).toBe(1987);
    expect(parseCardText(ocr([["'89 Fleer", 0.04]]), null).year).toBe(1989);
    expect(parseCardText(ocr([["He hit .300 in '87", 0.5]]), null).year).toBeNull();
  });

  it("does not read school names as players", () => {
    const p = parseCardText(null, ocr([["OKLAHOMA STATE", 0.1], ["TEXAS TECH", 0.2], ["TEXAS A&M", 0.3], ["BARRY SANDERS", 0.05]]));
    expect(p.playerCandidates).toEqual(["Barry Sanders"]);
  });

  it("reads a slab label line with a grade but no grader or cert, and ignores a grade word in a bio", () => {
    const p = parseCardText(ocr([["1986 FLEER #57 MICHAEL JORDAN NM-MT 8", 0.05]]), null);
    expect(p).toMatchObject({ grader: null, grade: "8", certNumber: null });
    expect(parseCardText(ocr([["Kept his rookie card in MINT 9 shape", 0.5]]), null).grade).toBeNull();
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

describe("real card fronts and holder labels (from the owner's sample photos)", () => {
  it("does not take OCR noise or card words as a player name", () => {
    for (const noise of ["IN ERT ARN EN", "HEROES FV", "CERTIFIED AUTO GRADE", "SIGNATURES"]) {
      expect(parseCardText(ocr([[noise, 0.6]]), null).playerCandidates, noise).toEqual([]);
    }
    expect(parseCardText(ocr([["BO JACKSON", 0.8]]), null).playerCandidates[0]).toBe("Bo Jackson");
    expect(parseCardText(ocr([["BILLY BEANE", 0.8]]), null).playerCandidates[0]).toBe("Billy Beane");
  });
  it("reads year, brand, autograph and grader from a holder label", () => {
    const p = parseCardText(ocr([["#422 ALEX RODRIGUEZ GML SP 1997 UPPER AUT BECKETT", 0.8]]), null);
    expect(p).toMatchObject({ year: 1997, brand: "Upper Deck", cardNumber: "422", grader: "Beckett" });
    expect(p.playerCandidates[0]).toBe("Alex Rodriguez");
    const aut = parseCardText(ocr([["#422 ALEX RODRIGUEZ GML SP 1997 UPPER AUT BECKETTs", 0.8]]), null);
    expect(aut).toMatchObject({ grader: "Beckett", isAutograph: true });
    const dna = parseCardText(ocr([["REPRINT CARD J KOOSMAN N. RYAN GEM MT 10 PSADNA CERTIFIED AUTO GRADE", 0.8]]), null);
    expect(dna).toMatchObject({ grader: "PSA/DNA", grade: "10", isAutograph: true, isReprint: true });
  });
});


describe("parsing rules from the Griffey card (task 9.11)", () => {
  const band = (text: string, y = 0.9): OcrLine => ({ text, confidence: 0.75, box: { x: 0.17, y, w: 0.8, h: 0.06 }, source: "band" });
  const withLines = (lines: OcrLine[]): OcrResult => ({ text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.7 });

  it("never takes a name from a bio sentence, but keeps the first word as a hint", () => {
    const cases: [string, string][] = [
      ["Ken graduated from Moeller (Cincinnati) High School", "Ken"],
      ["Bo played football at Auburn", "Bo"],
      ["Ken Graduated From Moeller High School In 1987.", "Ken"],
      ["Kirby Puckett Was Named Twins MVP And Led The League.", "Kirby"],
    ];
    for (const [line, hint] of cases) {
      const p = parseCardText(null, ocr([["GREGG OLSON", 0.06, 0.2, 0.5, 0.05, 0.85], [line, 0.6]]));
      expect(p.playerCandidates, line).toEqual(["Gregg Olson"]);
      expect(p.firstNameHint, line).toBe(hint);
    }
  });

  it("still reads short name lines that are not sentences", () => {
    for (const [line, name] of [
      ["KEN GRIFFEY JR.", "Ken Griffey Jr."],
      ["Ken Griffey, Jr.", "Ken Griffey Jr."],
      ["Bo Jackson", "Bo Jackson"],
    ]) {
      expect(parseCardText(null, ocr([[line, 0.06]])).playerCandidates[0], line).toBe(name);
    }
  });

  it("reads a name header with a suffix and a position", () => {
    const cases: [string, string, string, string | null][] = [
      ["CAL RIPKEN, JR. SS", "Cal Ripken Jr.", "SS", "baseball"],
      ["Ken Griffey, Jr. • OF", "Ken Griffey Jr.", "OF", "baseball"],
      ["4 Ken Griffey, Jr.® OF |", "Ken Griffey Jr.", "OF", "baseball"],
      ["BARRY SANDERS - RB", "Barry Sanders", "RB", "football"],
      ["Brett Hull · RW", "Brett Hull", "RW", "hockey"],
    ];
    for (const [line, name, position, sport] of cases) {
      // A busy front with a made up name in big letters must not beat the header.
      const front = ocr([["Tug ATAU LE LR", 0.08, 0.1, 0.8, 0.08, 0.5]]);
      const p = parseCardText(front, ocr([[line, 0.05, 0.2, 0.7, 0.06, 0.6]]));
      expect(p.playerCandidates[0], line).toBe(name);
      expect(p.position, line).toBe(position);
      expect(p.sport, line).toBe(sport);
    }
  });

  it("does not read a sentence or a stat header as a name header", () => {
    expect(parseCardText(null, ocr([["He was named the top SS", 0.5]])).playerCandidates).toEqual([]);
    expect(parseCardText(null, ocr([["YR CLUB G AB R H 2B", 0.3]])).playerCandidates).toEqual([]);
    expect(parseCardText(null, ocr([["MAJOR LEAGUE TOTALS OF", 0.3]])).playerCandidates).toEqual([]);
    expect(parseCardText(null, ocr([["NEW YORK OF", 0.1]])).playerCandidates).toEqual([]);
  });

  it("trusts a name in capitals read from a band, even cut short", () => {
    for (const [text, name] of [
      ["—~ KEN GRIFFEY, J", "Ken Griffey"],
      ["CAL RIPKEN, JR.", "Cal Ripken Jr."],
      ["BO JACKSON", "Bo Jackson"],
    ]) {
      // A page line high on the front would win without the band.
      const page: OcrLine = { text: "Hank Aaron", confidence: 0.9, box: { x: 0.1, y: 0.05, w: 0.5, h: 0.1 } };
      const p = parseCardText(withLines([page, band(text)]), null);
      expect(p.playerCandidates[0], text).toBe(name);
    }
    const plain = parseCardText(withLines([
      { text: "Hank Aaron", confidence: 0.9, box: { x: 0.1, y: 0.05, w: 0.5, h: 0.1 } },
      { ...band("KEN GRIFFEY, J"), source: "page" },
    ]), null);
    expect(plain.playerCandidates[0]).toBe("Hank Aaron");
  });

  it("reads team names in capitals with one letter wrong or missing, as a hint only (10.10)", () => {
    for (const [line, team] of [
      ["89 MARMNERS", "Seattle Mariners"],
      ["DODGRS", "Los Angeles Dodgers"],
      ["BREWFRS 1B", "Milwaukee Brewers"],
    ]) {
      const p = parseCardText(null, ocr([[line, 0.4]]));
      expect(p.team, line).toBeNull();
      expect(p.teamHint, line).toBe(team);
    }
    // Not in capitals, or too short to be sure: no team, no hint.
    expect(parseCardText(null, ocr([["Marmners", 0.4]])).teamHint).toBeNull();
    expect(parseCardText(null, ocr([["MET", 0.4]])).teamHint).toBeNull();
  });

  it("does not turn surnames and plain words into teams (9.11 review)", () => {
    // The real team is read: a surname one letter from a nickname must not beat it.
    const brewer = parseCardText(ocr([["TOM BREWER", 0.85], ["PITCHER", 0.9]]), ocr([["RED SOX", 0.1]]));
    expect(brewer.team).toBe("Boston Red Sox");
    expect(brewer.playerCandidates[0]).toBe("Tom Brewer");
    const brown = parseCardText(ocr([["KEVIN BROWN", 0.85], ["PITCHER", 0.9]]), null);
    expect(brown.team).toBeNull();
    expect(brown.sport).toBe("baseball");
    for (const line of [
      "JIM BROWN", "ALL-STAR ROOKIES", "CAPITAL CITY", "A GIANT SEASON", "MINERS", "TIGER", "RANGER", "ROYAL", "BRAVE",
      "RAIDER", "CARDINAL", "INDIAN", "LAKER", "MAKERS", "ROOKIE", "ROOKIES", "CAPITAL", "BREWER", "GIANT", "PHILLIPS",
      "INDIANA", "MARINES", "RANGES", "CHARGES", "RODGERS", "GRAVES", "SPARKS", "LAKES", "TIERS", "BOILERS",
    ]) {
      const p = parseCardText(ocr([[line, 0.4]]), null);
      expect(p.team, line).toBeNull();
      expect(p.sport, line).toBeNull();
    }
  });

  it("keeps close team spellings narrow (9.11 review)", () => {
    const team = (line: string) => parseCardText(null, ocr([[line, 0.4]])).teamHint;
    // One letter wrong, or one left out that is not one of the last two.
    expect(team("MARMNERS")).toBe("Seattle Mariners");
    expect(team("MARNERS")).toBe("Seattle Mariners");
    expect(team("PHILIES")).toBe("Philadelphia Phillies");
    // The last letters left out, a wrong first letter, an added letter, two letters wrong: no team.
    expect(team("MARINER")).toBeNull();
    expect(team("MARINES")).toBeNull();
    expect(team("NARINERS")).toBeNull();
    expect(team("MARIINERS")).toBeNull();
    expect(team("MARMNFRS")).toBeNull();
    // Never from a line that gave a player name candidate.
    const named = parseCardText(ocr([["DARRYL BREWFRS", 0.85]]), null);
    expect(named.playerCandidates).toEqual(["Darryl Brewfrs"]);
    expect(named.team).toBeNull();
    expect(named.teamHint).toBeNull();
  });

  it("uses a close team spelling only when no team was read exactly, and only as a hint (9.11 review, 10.10)", () => {
    // Two close spellings in big letters on the front lose to one exact team in a sentence on the back.
    // Two teams were read, so neither is written: the exact one is the hint.
    const p = parseCardText(
      ocr([["BREWFRS", 0.1], ["BREWFRS", 0.9]]),
      ocr([["Traded to the RED SOX for two players in 1989", 0.6]]),
    );
    expect(p.team).toBeNull();
    expect(p.teamHint).toBe("Boston Red Sox");
    // On its own a close spelling gives a hint and, at half weight, the sport.
    expect(parseCardText(null, ocr([["BREWFRS", 0.4]]))).toMatchObject({ team: null, teamHint: "Milwaukee Brewers", sport: "baseball" });
    // An exact team outvotes a position on the sport.
    expect(parseCardText(null, ocr([["COWBOYS", 0.4], ["SS", 0.5]])).sport).toBe("football");
  });

  it("does not call a name with a small lowercase word a sentence (9.11 review)", () => {
    for (const [line, name] of [
      ["Jose de Jesus", "Jose De Jesus"],
      ["Andy van Slyke", "Andy Van Slyke"],
      ["Luis de Leon", "Luis De Leon"],
      ["Ed von Ohlen", "Ed Von Ohlen"],
    ]) {
      const p = parseCardText(null, ocr([[line, 0.06]]));
      expect(p.playerCandidates, line).toEqual([name]);
      expect(p.firstNameHint, line).toBeNull();
    }
    // A small word does not hide a real sentence.
    for (const line of ["Jose de Jesus pitched for the Royals", "Ken la played", "Jose graduated de Jesus"]) {
      expect(parseCardText(null, ocr([[line, 0.5]])).playerCandidates, line).toEqual([]);
    }
  });

  it("takes no year from header lines that look like stat rows (9.11 review)", () => {
    const stats = (p: ParsedCard) => p.evidence.filter((e) => /stat table/.test(e));
    // A season followed by a brand name is a header, with or without numbers.
    for (const rows of [
      [["88 UPPER DECK", 0.3], ["89 UPPER DECK", 0.34]],
      [["1988 UPPER DECK", 0.3], ["1989 UPPER DECK", 0.34]],
      [["88 TOPPS", 0.3], ["89 TOPPS 336", 0.34]],
      [["88 DONRUSS 1 2 3", 0.3], ["89 FLEER 1 2 3", 0.34]],
    ] as Row[][]) {
      const p = parseCardText(null, ocr(rows));
      expect(stats(p), rows[0][0]).toEqual([]);
      expect(p.year, rows[0][0]).not.toBe(1990);
    }
    expect(parseCardText(null, ocr([["88 UPPER DECK", 0.3], ["89 UPPER DECK", 0.34]])).year).toBeNull();
    // A full year needs numbers after the club; only a two digit season may stand with the club alone.
    expect(parseCardText(null, ocr([["1988 MONTHLY SCOREBOARD", 0.3], ["1989 MONTHLY SCOREBOARD", 0.34]])).year).toBeNull();
    // A full year with the club alone is a split row too (10.10, M1).
    expect(parseCardText(null, ocr([["1988 VERMONT", 0.3], ["1989 MARINERS", 0.34]])).year).toBe(1990);
    expect(parseCardText(null, ocr([["1988 VERMONT 17 61 10", 0.3], ["1989 MARINERS 127 455 61", 0.34]])).year).toBe(1990);
    expect(parseCardText(null, ocr([["88 VERMONT", 0.3], ["89 MARINERS", 0.34]])).year).toBe(1990);
    // A header above a real table does not get in the way.
    const p = parseCardText(null, ocr([["86 UPPER DECK", 0.2], ["88 VERMONT 17 61 10", 0.3], ["89 MARINERS 127 455 61", 0.34]]));
    expect(p.year).toBe(1990);
  });

  it("takes the team hint from the last stat table row; two teams read write no team (10.10)", () => {
    const p = parseCardText(null, ocr([
      ["87 PADRES 50 120 10", 0.3],
      ["88 PADRES 140 480 61", 0.34],
      ["89 YANKEES 127 455 61", 0.38],
    ]));
    expect(p.team).toBeNull();
    expect(p.teamHint).toBe("New York Yankees");
    // One club in the table: written.
    expect(parseCardText(null, ocr([["88 YANKEES 140 480 61", 0.34], ["89 YANKEES 127 455 61", 0.38]])).team).toBe("New York Yankees");
  });

  it("reads the year from split stat rows with a repeated season", () => {
    const rows: Row[] = [
      ["87 BELLINGHAM", 0.31],
      ["53 178", 0.31, 0.5],
      ["88 SN BERNARDINO", 0.35],
      ["88 VERMONT", 0.4],
      ["89 MARMNERS", 0.44],
    ];
    expect(parseCardText(null, ocr(rows)).year).toBe(1990);
    expect(parseCardText(null, ocr([["85 ROYALS", 0.3], ["86 ROYALS 150 520 81", 0.34]])).year).toBe(1987);
    expect(parseCardText(null, ocr([["89 MARINERS 127 455 61", 0.3], ["88 VERMONT", 0.34]])).year).toBeNull();
    expect(parseCardText(null, ocr([["88 VERMONT", 0.3], ["88 MARINERS", 0.34]])).year).toBeNull();
    expect(parseCardText(null, ocr([["53 178", 0.3], ["54 219", 0.34]])).year).toBeNull();
  });

  it("reads TOPPS anywhere on the card", () => {
    expect(parseCardText(ocr([["TOPPS", 0.9, 0.05, 0.2, 0.02], ["ALL-STAR ROOKIE", 0.92, 0.05, 0.2, 0.02]]), null).brand).toBe("Topps");
    expect(parseCardText(ocr([["TOPPS ALL-STAR ROOKIE", 0.9]]), null).brand).toBe("Topps");
    const edge: OcrLine = { text: "© 1990 THE TOPPS COMPANY, INC.", confidence: 0.6, box: { x: 0.92, y: 0.3, w: 0.03, h: 0.6 }, source: "edge" };
    const p = parseCardText(null, withLines([edge]));
    expect(p).toMatchObject({ brand: "Topps", year: 1990 });
  });
});

describe("team and year rules from the second Part C review (task 10.10)", () => {
  const team = (front: Row[], back: Row[] | null = null) => {
    const p = parseCardText(ocr(front), back ? ocr(back) : null);
    return { team: p.team, hint: p.teamHint };
  };
  const stats = (p: ParsedCard) => p.evidence.filter((e) => /stat table/.test(e));

  it("H1: a lowercase bio word (twins) never beats a misread front team, and is never written", () => {
    const back: Row[] = [
      ["GREGG OLSON", 0.06, 0.2, 0.5, 0.05, 0.85],
      ["His two sons are twins and both play ball in high school.", 0.6],
    ];
    const r = team([["MARMNERS", 0.9]], back);
    expect(r.team).toBeNull();
    expect(r.hint).toBe("Seattle Mariners");
    // The lowercase word alone gives nothing at all.
    expect(team([["GREGG OLSON", 0.1]], [["He and his brother are twins", 0.6]])).toEqual({ team: null, hint: null });
    expect(team([["the twins", 0.5]])).toEqual({ team: null, hint: null });
    // A front team read exactly is not blocked by the lowercase word.
    expect(team([["MARINERS", 0.9]], back)).toEqual({ team: "Seattle Mariners", hint: null });
  });

  it("M1: split stat rows with four digit years keep the year", () => {
    const p = parseCardText(null, ocr([["1987 BELLINGHAM", 0.31], ["1988 VERMONT", 0.4], ["1989 MARINERS", 0.44]]));
    expect(p.year).toBe(1990);
    expect(stats(p).length).toBe(1);
    const sn = parseCardText(null, ocr([["1987 BELLINGHAM", 0.31], ["1988 SN BERNARDINO", 0.35], ["1988 VERMONT", 0.4], ["1989 MARINERS", 0.44]]));
    expect(sn.year).toBe(1990);
    // Two digit rows still work.
    expect(parseCardText(null, ocr([["87 BELLINGHAM", 0.31], ["88 VERMONT", 0.4], ["89 MARINERS", 0.44]])).year).toBe(1990);
  });

  it("M2: card headers and checklist rows are not club rows and give no year", () => {
    for (const rows of [
      [["88 ROOKIE", 0.3], ["89 ROOKIE", 0.34]],
      [["1988 ROOKIE", 0.3], ["1989 ROOKIE", 0.34]],
      [["86 ALL STAR", 0.3], ["87 DRAFT PICK", 0.34]],
      [["87 DRAFT PICK", 0.3], ["88 VERMONT", 0.34]],
      [["56 JOHN SMITH", 0.3], ["57 BOB JONES", 0.34]],
      [["55 MIKE BROWN", 0.3], ["56 JOHN SMITH", 0.34], ["57 BOB JONES", 0.38]],
      [["1988 MONTHLY", 0.3], ["1989 MONTHLY", 0.34]],
    ] as Row[][]) {
      const p = parseCardText(null, ocr(rows));
      expect(stats(p), rows.map((r) => r[0]).join(" / ")).toEqual([]);
      expect(p.year, rows.map((r) => r[0]).join(" / ")).toBeNull();
    }
  });

  it("M3: a small l read for a capital I in a word in capitals is read as I", () => {
    expect(team([["MARlNERS", 0.9]])).toEqual({ team: "Seattle Mariners", hint: null });
    expect(parseCardText(null, ocr([["88 VERMONT 17 61 10", 0.3], ["89 MARlNERS 127 455 61", 0.34]]))).toMatchObject({ team: "Seattle Mariners", year: 1990 });
    expect(parseCardText(ocr([["KEN GRlFFEY JR.", 0.9, 0.1, 0.5, 0.05]]), null).playerCandidates[0]).toBe("Ken Griffey Jr.");
    expect(team([["PHlLLlES", 0.9]])).toEqual({ team: "Philadelphia Phillies", hint: null });
    // Words in lower case keep their l.
    expect(parseCardText(null, ocr([["Bill Wells", 0.06]])).playerCandidates[0]).toBe("Bill Wells");
  });

  it("M4: plain words are never written as teams and give no hint", () => {
    for (const line of [
      "TOPPS STARS", "SUPER STARS", "He bears down", "A MAGIC MOMENT", "BRINGS THE HEAT", "PAID HIS BILLS", "JEFF KINGS",
      "KINGS MOUNTAIN", "He jets around", "LSU TIGERS", "He Bears Down On Hitters", "Topps Stars",
    ]) {
      expect(team([["GREGG OLSON", 0.1]], [[line, 0.6]]), line).toEqual({ team: null, hint: null });
      expect(team([[line, 0.6]]), line).toEqual({ team: null, hint: null });
    }
    // The same nicknames on a team line are still read.
    expect(team([["CHICAGO BEARS", 0.9]]).team).toBe("Chicago Bears");
    expect(team([["HEAT GUARD", 0.9]]).team).toBe("Miami Heat");
    expect(team([["DETROIT TIGERS OF", 0.9]]).team).toBe("Detroit Tigers");
  });

  it("L1: surnames and words close to a nickname give no team and no hint", () => {
    for (const word of ["FALCONE", "ANGELL", "PILATES", "CHARMERS", "FRYERS", "PAGERS", "RADERS", "SHACKS", "DEVINS"]) {
      expect(team([[word, 0.6]]), word).toEqual({ team: null, hint: null });
      expect(team([["GREGG OLSON", 0.1]], [[`${word} 1989`, 0.6]]), word).toEqual({ team: null, hint: null });
    }
  });

  it("L2: a close team spelling with a position of another sport gives no team and no hint", () => {
    expect(team([["COWBQYS", 0.4], ["SS", 0.5]])).toEqual({ team: null, hint: null });
    expect(team([["89 MARMNERS", 0.4], ["QB", 0.5]])).toEqual({ team: null, hint: null });
    expect(team([["PHILIES", 0.4], ["LW", 0.5]])).toEqual({ team: null, hint: null });
    // With a position of the same sport the hint stays.
    expect(team([["89 MARMNERS", 0.4], ["OF", 0.5]])).toEqual({ team: null, hint: "Seattle Mariners" });
  });
});
