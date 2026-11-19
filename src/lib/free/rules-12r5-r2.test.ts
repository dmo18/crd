import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText } from "./parse";

/**
 * 12R.5 round 2: honest certainty per field and rules by principle, each on
 * made-up cards of several sports and eras (boxes as fractions of the card).
 * None of these is shaped after one bench card.
 */

/** [text, y, x, w, h, twice] */
type Row = [string, number, number?, number?, number?, boolean?];

function side(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y, x = 0.1, w = 0.6, h = 0.03, twice]) => ({ text, confidence: 0.95, box: { x, y, w, h }, ...(twice ? { twice } : {}) }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9 };
}
const parse = (front: Row[] | null, back: Row[] | null) => parseCardText(front ? side(front) : null, back ? side(back) : null);

describe("certainty: sure only when two signs agree", () => {
  const front: Row[] = [["TOPPS", 0.05, 0.1, 0.2, 0.04], ["MARK GRACE", 0.9, 0.3, 0.4, 0.05]];
  const back: Row[] = [
    ["MARK GRACE", 0.06, 0.3, 0.4, 0.04],
    ["88 CUBS 134 486 65", 0.6, 0.1, 0.6, 0.02],
    ["89 CUBS 142 510 74", 0.63, 0.1, 0.6, 0.02],
    ["© 1990 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02],
  ];

  it("player, year and brand sure with the front, the back heading, the copyright and the stat table", () => {
    const p = parse(front, back);
    expect(p).toMatchObject({ player: "Mark Grace", year: 1990, brand: "Topps" });
    expect(p.certainty).toMatchObject({ player: "sure", year: "sure", brand: "sure" });
  });

  it("one sign alone is unsure", () => {
    const p = parse(null, [["© 1990 TOPPS CHEWING GUM, INC.", 0.95, 0.1, 0.8, 0.02]]);
    expect(p).toMatchObject({ year: 1990, brand: "Topps" });
    expect(p.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
    const name = parse([["MARK GRACE", 0.9, 0.3, 0.4, 0.05]], null);
    expect(name.player).toBe("Mark Grace");
    expect(name.certainty.player).toBe("unsure");
  });

  it("a back heading backed by the bio's use of the name is sure; a name the card never repeats is not", () => {
    const heading: Row = ["JIM KELLY", 0.06, 0.3, 0.4, 0.05];
    expect(parse(null, [heading, ["Jim threw for 3,000 yards in his", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("sure");
    expect(parse(null, [heading, ["He threw for 3,000 yards in his", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
  });

  it("a front year the copyright cannot fit leaves the year blank", () => {
    const f: Row[] = [["1992 DONRUSS", 0.05, 0.1, 0.3, 0.04]];
    expect(parse(f, [["© 1991 LEAF, INC.", 0.95, 0.1, 0.6, 0.02]]).year).toBe(1992);
    expect(parse(f, [["© 1988 LEAF, INC.", 0.95, 0.1, 0.6, 0.02]]).year).toBeNull();
    // A stat table that runs past the front's year contradicts it too.
    expect(parse(f, [["92 ORIOLES 4.01 31", 0.6], ["93 ORIOLES 3.90 30", 0.63]]).year).toBeNull();
  });

  it("makers of two different companies named as logo and copyright leave the brand blank", () => {
    expect(parse([["TOPPS", 0.05, 0.1, 0.2, 0.04]], [["© 1990 FLEER CORP.", 0.95, 0.1, 0.6, 0.02]]).brand).toBeNull();
    // One company: Leaf, Inc. owned Donruss; Pinnacle Brands made Score.
    const d = parse([["DONRUSS", 0.05, 0.1, 0.2, 0.04]], [["© 1991 LEAF, INC.", 0.95, 0.1, 0.6, 0.02]]);
    expect(d.brand).toBe("Donruss");
    expect(d.certainty.brand).toBe("sure");
    expect(parse([["SCORE", 0.05, 0.1, 0.2, 0.04]], [["© 1994 PINNACLE BRANDS, INC.", 0.95, 0.1, 0.6, 0.02]]).brand).toBe("Score");
  });

  it("card number: a corner number sure with the No. marker or a second read, blank when a marker disagrees", () => {
    const tail: Row = ["Some words here", 0.5];
    expect(parse(null, [["412", 0.04, 0.85, 0.08, 0.04], tail]).certainty.cardNumber).toBe("unsure");
    expect(parse(null, [["412", 0.04, 0.85, 0.08, 0.04, true], tail]).certainty.cardNumber).toBe("sure");
    const both = parse([["NO. 412", 0.9, 0.1, 0.2, 0.03]], [["412", 0.04, 0.85, 0.08, 0.04], tail]);
    expect(both.cardNumber).toBe("412");
    expect(both.certainty.cardNumber).toBe("sure");
    expect(parse(null, [["412", 0.04, 0.85, 0.08, 0.04], ["NO. 87", 0.5, 0.1, 0.2, 0.03]]).cardNumber).toBeNull();
  });
});

describe("sport is never guessed", () => {
  it("a maker of many sports is no sign of one", () => {
    expect(parse(null, [["© 1990 DONRUSS", 0.95, 0.1, 0.6, 0.02]]).sport).toBeNull();
    expect(parse(null, [["© 1991 PRO SET, INC.", 0.95, 0.1, 0.6, 0.02]]).sport).toBeNull();
    expect(parse(null, [["© 1992 SKYBOX", 0.95, 0.1, 0.6, 0.02]]).sport).toBeNull();
  });

  it.each([
    ["PREMIER LEAGUE", "soccer"], ["FIFA WORLD CUP", "soccer"], ["MLS", "soccer"], ["LA LIGA", "soccer"],
    ["PGA TOUR", "golf"], ["NASCAR WINSTON CUP", "racing"], ["WWE", "wrestling"], ["WBC HEAVYWEIGHT", "boxing"],
    ["UFC", "other"], ["NHL", "hockey"], ["NBA", "basketball"],
  ])("reads %s as %s", (words, sport) => {
    expect(parse(null, [[words, 0.1, 0.1, 0.4, 0.03]]).sport).toBe(sport);
  });

  it("soccer clubs and football as the world calls it", () => {
    const p = parse(null, [["REAL MADRID", 0.1, 0.1, 0.4, 0.03], ["FOOTBALL", 0.2, 0.1, 0.3, 0.03]]);
    expect(p.sport).toBe("soccer");
    const pl = parse(null, [["MIDFIELDER", 0.1, 0.1, 0.3, 0.03], ["PREMIER LEAGUE", 0.2, 0.1, 0.4, 0.03]]);
    expect(pl).toMatchObject({ sport: "soccer" });
    expect(pl.certainty.sport).toBe("sure");
  });

  it("signs of two sports leave the sport blank", () => {
    expect(parse(null, [["NHL", 0.1, 0.1, 0.2, 0.03], ["NFL", 0.2, 0.1, 0.2, 0.03], ["QUARTERBACK", 0.3, 0.1, 0.3, 0.03]]).sport).toBeNull();
  });

  it("one kind of sign fills the sport unsure; two kinds make it sure", () => {
    expect(parse(null, [["NBA", 0.1, 0.1, 0.2, 0.03]]).certainty.sport).toBe("unsure");
    expect(parse(null, [["NBA", 0.1, 0.1, 0.2, 0.03], ["GUARD", 0.2, 0.1, 0.2, 0.03]]).certainty.sport).toBe("sure");
  });
});

describe("season sports: the first year of the season", () => {
  it.each([
    ["2003-04 TOPPS", 2003], ["2003-2004 UPPER DECK", 2003], ["'97-98 FLEER", 1997], ["1993-94 SKYBOX", 1993],
  ])("%s on the front gives %d", (text, year) => {
    expect(parse([[text, 0.05, 0.1, 0.4, 0.04]], null).year).toBe(year);
  });

  it("a copyright in the season's second year agrees with the front", () => {
    const p = parse([["2003-04 TOPPS", 0.05, 0.1, 0.4, 0.04]], [["© 2004 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.6, 0.02]]);
    expect(p.year).toBe(2003);
    expect(p.certainty.year).toBe("sure");
  });

  it("a graded holder label's season counts as the label's year", () => {
    const label: Row[] = [["2003-04 UPPER DECK", 0.04, 0.1, 0.5, 0.03], ["PSA", 0.04, 0.8, 0.1, 0.03], ["GEM MT 10", 0.08, 0.7, 0.2, 0.03]];
    expect(parse(label, null)).toMatchObject({ year: 2003, brand: "Upper Deck", grader: "PSA" });
  });
});

describe("makers and their products, by era", () => {
  const copy = (text: string): Row => [text, 0.95, 0.1, 0.7, 0.02];

  it("Panini products from 2010 on: brand Panini, the product as the set", () => {
    const prizm = parse([["PRIZM", 0.05, 0.1, 0.2, 0.04]], [copy("© 2021 Panini America, Inc.")]);
    expect(prizm).toMatchObject({ brand: "Panini", setName: "Prizm", year: 2021 });
    expect(prizm.certainty).toMatchObject({ brand: "sure", setName: "sure" });
    expect(parse([["DONRUSS", 0.05, 0.1, 0.2, 0.04]], [copy("© 2015 Panini America, Inc.")])).toMatchObject({ brand: "Panini", setName: "Donruss" });
    expect(parse([["OPTIC", 0.05, 0.1, 0.2, 0.04]], [copy("© 2019 Panini America, Inc.")])).toMatchObject({ brand: "Panini", setName: "Optic" });
    expect(parse([["SELECT", 0.05, 0.1, 0.2, 0.04]], [copy("© 2020 Panini America, Inc.")])).toMatchObject({ brand: "Panini", setName: "Select" });
  });

  it("before 2010 Donruss and Score are makers themselves, and Contenders is Playoff's", () => {
    expect(parse([["DONRUSS", 0.05, 0.1, 0.2, 0.04]], [copy("© 1992 LEAF, INC.")])).toMatchObject({ brand: "Donruss", setName: null });
    expect(parse([["SCORE", 0.05, 0.1, 0.2, 0.04]], [copy("© 1990 SCORE")])).toMatchObject({ brand: "Score", setName: null });
    expect(parse([["CONTENDERS", 0.05, 0.1, 0.3, 0.04]], [copy("© 2005 PLAYOFF CORP.")])).toMatchObject({ brand: "Playoff", setName: "Contenders" });
  });

  it("Topps and Upper Deck products", () => {
    expect(parse([["BLACK DIAMOND", 0.05, 0.1, 0.3, 0.04]], [copy("© 1999 The Upper Deck Company")])).toMatchObject({ brand: "Upper Deck", setName: "Black Diamond" });
    expect(parse([["HERITAGE", 0.05, 0.1, 0.3, 0.04]], [copy("© 2005 THE TOPPS COMPANY, INC.")])).toMatchObject({ brand: "Topps", setName: "Heritage" });
    expect(parse([["BOWMAN CHROME", 0.05, 0.1, 0.3, 0.04]], null)).toMatchObject({ brand: "Topps", setName: "Bowman Chrome" });
    expect(parse([["ALLEN & GINTER", 0.05, 0.1, 0.3, 0.04]], null)).toMatchObject({ brand: "Topps", setName: "Allen & Ginter" });
  });

  it("a set is filled only when read", () => {
    expect(parse(null, [copy("© 1999 The Upper Deck Company")]).setName).toBeNull();
  });
});

describe("names", () => {
  it("accents and case never block a match", () => {
    const p = parse([["Álvaro Morata", 0.9, 0.3, 0.4, 0.05]], [["ÁLVARO MORATA", 0.06, 0.3, 0.4, 0.05]]);
    expect(p.player).toBe("Álvaro Morata");
    expect(p.certainty.player).toBe("sure");
    expect(parse([["Ronald Acuña Jr.", 0.9, 0.3, 0.4, 0.05]], null).player).toBe("Ronald Acuña Jr.");
  });

  it("keeps surnames of several words and suffixes", () => {
    expect(parse([["Oscar De La Hoya", 0.9, 0.3, 0.5, 0.05]], null).player).toBe("Oscar De La Hoya");
    expect(parse([["KEN GRIFFEY JR.", 0.9, 0.3, 0.5, 0.05]], null).player).toBe("Ken Griffey Jr.");
    // A position after the name is not a name particle.
    expect(parse([["JOHN SMITH DE", 0.9, 0.3, 0.5, 0.05]], null).player).toBe("John Smith");
  });

  it("never takes a product or section name for a player", () => {
    expect(parse([["BLACK DIAMOND", 0.05, 0.1, 0.5, 0.08]], null).player).toBeNull();
    expect(parse([["YOUNG GUNS", 0.05, 0.1, 0.5, 0.08]], null).player).toBeNull();
    expect(parse([["CAREER HIGHLIGHTS", 0.05, 0.1, 0.5, 0.08]], null).player).toBeNull();
  });
});
