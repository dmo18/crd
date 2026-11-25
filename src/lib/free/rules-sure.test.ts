import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText } from "./parse";

/**
 * More honest "sure" marks (product run, 2026-11-25): a second, independent
 * sign that agrees, by general rules on made-up cards of several makers and
 * eras. Each rule also shows what it never does.
 */

/** [text, y, x, w, h, confidence] */
type Row = [string, number, number?, number?, number?, number?];

function side(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y, x = 0.1, w = 0.6, h = 0.03, confidence = 0.97]) => ({ text, confidence, box: { x, y, w, h } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9 };
}
const parse = (front: Row[] | null, back: Row[] | null) => parseCardText(front ? side(front) : null, back ? side(back) : null);

describe("a copyright mark read as a letter stuck to the year", () => {
  it("D1988 THEFLEER: year and maker read as a copyright line", () => {
    const p = parse(null, [["BOB SMITH", 0.05, 0.3, 0.4, 0.05], ["D1988 THEFLEER CORP", 0.95, 0.1, 0.5, 0.02]]);
    expect(p).toMatchObject({ year: 1988, brand: "Fleer" });
  });

  it("needs a maker's name on the line: a plain word with a year is no copyright", () => {
    const p = parse(null, [["BOB SMITH", 0.05, 0.3, 0.4, 0.05], ["C1988 CHAMPIONS", 0.95, 0.1, 0.5, 0.02]]);
    expect(p.year).toBeNull();
    expect(p.brand).toBeNull();
  });
});

describe("a maker logo with one letter misread confirms, never decides", () => {
  const copyright: Row = ["© 1989 THE TOPPS COMPANY, INC.", 0.95, 0.1, 0.7, 0.02];

  it("TQPPS in the corner and the copyright line: Topps is sure", () => {
    const p = parse(null, [["TQPPS", 0.04, 0.05, 0.1, 0.06], copyright]);
    expect(p.brand).toBe("Topps");
    expect(p.certainty.brand).toBe("sure");
  });

  it("alone it gives no brand", () => {
    const p = parse(null, [["TQPPS", 0.04, 0.05, 0.1, 0.06], ["JIM BROWN", 0.1, 0.3, 0.4, 0.05]]);
    expect(p.brand).toBeNull();
  });

  it("a misread logo of another maker is no sign for the copyright's maker", () => {
    const p = parse(null, [["FLEEP", 0.04, 0.05, 0.1, 0.06], copyright]);
    expect(p.brand).toBe("Topps");
    expect(p.certainty.brand).toBe("unsure");
  });
});

describe("a logo printed with dots between its letters", () => {
  it("UPPER over D·E·C·K is the Upper Deck logo, a second place with the copyright", () => {
    const p = parse(null, [
      ["UPPER", 0.88, 0.08, 0.11, 0.02],
      ["D·E·C·K", 0.9, 0.08, 0.11, 0.02],
      ["©1997 The Upper Deck Company, LLC. All Rights Reserved.", 0.9, 0.33, 0.45, 0.02],
    ]);
    expect(p.brand).toBe("Upper Deck");
    expect(p.certainty.brand).toBe("sure");
  });
});

describe("the set's own line agrees with the copyright year", () => {
  it("2019 PANINI - DONRUSS FOOTBALL and © 2019 Panini: the year is sure", () => {
    const p = parse(null, [
      ["2019 PANINI - DONRUSS FOOTBALL", 0.7, 0.3, 0.3, 0.02],
      ["© 2019 Panini America, Inc. Produced in the USA.", 0.72, 0.25, 0.5, 0.02],
    ]);
    expect(p.year).toBe(2019);
    expect(p.certainty.year).toBe("sure");
  });

  it("a season line counts by its first year (2015-16 and ©2015)", () => {
    const p = parse(null, [["2015-16 ARTIFACTS", 0.8, 0.2, 0.3, 0.03], ["©2015 UDC. All rights reserved.", 0.9, 0.3, 0.3, 0.02]]);
    expect(p.year).toBe(2015);
    expect(p.certainty.year).toBe("sure");
  });

  it("a set line with another year adds nothing", () => {
    const p = parse(null, [["2018 PANINI - PRIZM", 0.7, 0.3, 0.3, 0.02], ["© 2019 Panini America, Inc.", 0.72, 0.25, 0.5, 0.02]]);
    expect(p.certainty.year).toBe("unsure");
  });

  it("the copyright line alone stays one sign", () => {
    const p = parse(null, [["© 2019 Panini America, Inc. Produced in the USA.", 0.72, 0.25, 0.5, 0.02]]);
    expect(p.certainty.year).toBe("unsure");
  });
});

describe("a lone season row with its totals row misread", () => {
  it("88-89 row, then PrqTotals: the last season is 88-89, with the copyright the year is sure", () => {
    const p = parse(null, [
      ["Year Club G FG% FT% REB AST PTS AVG", 0.85, 0.09, 0.6, 0.04],
      ["88-89 Chicago 81 535 850 652 563 2633 32.5", 0.89, 0.09, 0.6, 0.03],
      ["PrqTotuls", 0.93, 0.15, 0.07, 0.04],
      ["© 1989 FLEER CORP. PRINTED IN U.S.A.", 0.5, 0.9, 0.03, 0.5],
    ]);
    expect(p.year).toBe(1989);
    expect(p.certainty.year).toBe("sure");
  });

  it("a lone row with no totals row under it is not a table", () => {
    const p = parse(null, [
      ["Best Year 88-89 Chicago 81 535 850 652 563 2633 32.5", 0.89, 0.09, 0.6, 0.03],
      ["© 1989 FLEER CORP. PRINTED IN U.S.A.", 0.5, 0.9, 0.03, 0.5],
    ]);
    expect(p.certainty.year).toBe("unsure");
  });
});

describe("the card number in the maker's place and form", () => {
  it("No. RS-12 alone in a top corner of the back, read clearly: sure", () => {
    const p = parse(null, [["No. RS-12", 0.05, 0.06, 0.15, 0.03, 0.98], ["MIKE TROUT", 0.45, 0.25, 0.5, 0.04]]);
    expect(p.cardNumber).toBe("RS-12");
    expect(p.certainty.cardNumber).toBe("sure");
  });

  it("the same mark in the middle of the back, or read poorly, stays unsure", () => {
    expect(parse(null, [["No. RS-12", 0.5, 0.4, 0.15, 0.03, 0.98]]).certainty.cardNumber).toBe("unsure");
    expect(parse(null, [["No. RS-12", 0.05, 0.06, 0.15, 0.03, 0.8]]).certainty.cardNumber).toBe("unsure");
  });

  it("a # number in a corner is still one sign (jerseys use # too)", () => {
    expect(parse(null, [["#12", 0.05, 0.06, 0.1, 0.03, 0.99]]).certainty.cardNumber).toBe("unsure");
  });
});

describe("the player's name on the back without its space", () => {
  it("JOHN SMITHSON on the front and JOHNSMITHSON on the back: sure; other letters are not the name", () => {
    const p = parse([["JOHN SMITHSON", 0.85, 0.3, 0.4, 0.05]], [["JOHNSMITHSON", 0.4, 0.3, 0.4, 0.04]]);
    expect(p.player).toBe("John Smithson");
    expect(p.certainty.player).toBe("sure");
    const other = parse([["JOHN SMITHSON", 0.85, 0.3, 0.4, 0.05]], [["JOHNSMITHSONS", 0.4, 0.3, 0.4, 0.04]]);
    expect(other.certainty.player).toBe("unsure");
  });
});

describe("a first name misread on the front, read well on the back", () => {
  it("Wike Piazza on the front, Mike Piazza on the back: Mike Piazza, sure", () => {
    const p = parse([["Wike Piazza", 0.06, 0.3, 0.3, 0.04]], [["Mike Piazza", 0.05, 0.3, 0.3, 0.04]]);
    expect(p.player).toBe("Mike Piazza");
    expect(p.certainty.player).toBe("sure");
  });
});

describe("a guard on a football card", () => {
  it("GUARD with the Denver Broncos is a football card, not two sports", () => {
    const p = parse(null, [["DENVER BRONCOS", 0.14, 0.07, 0.2, 0.03], ["GUARD", 0.66, 0.08, 0.05, 0.03]]);
    expect(p.sport).toBe("football");
  });

  it("GUARD with a basketball team still says basketball", () => {
    const p = parse(null, [["CHICAGO BULLS", 0.14, 0.07, 0.2, 0.03], ["GUARD", 0.66, 0.08, 0.05, 0.03]]);
    expect(p.sport).toBe("basketball");
    expect(p.certainty.sport).toBe("sure");
  });
});
