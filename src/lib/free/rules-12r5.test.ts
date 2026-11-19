import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText } from "./parse";

/**
 * Reading rules added in 12R.5, each on a made-up layout shaped like the
 * text the reader returned for the tuning cards (boxes as fractions of the
 * card). Each rule is about how cards are printed, never about one card.
 */

/** [text, y, x, w, h] */
type Row = [string, number, number?, number?, number?];

function side(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y, x = 0.1, w = 0.6, h = 0.03]) => ({ text, confidence: 0.95, box: { x, y, w, h } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9 };
}
const parse = (front: Row[] | null, back: Row[] | null) => parseCardText(front ? side(front) : null, back ? side(back) : null);

describe("brand: licence text is never the maker", () => {
  it("reads the maker, not NBA Properties, and a maker's name printed in two stacked words", () => {
    const back: Row[] = [
      ["2 NBA TOTALS", 0.7, 0.2, 0.13, 0.02],
      ["UPPER", 0.88, 0.1, 0.11, 0.02],
      ["DECK", 0.9, 0.1, 0.11, 0.02],
      ["the U.S.A. ©1999 NBA Properties, Inc.", 0.91, 0.34, 0.2, 0.02],
      ["TM", 0.92, 0.18, 0.03, 0.02],
    ];
    expect(parse(null, back).brand).toBe("Upper Deck");
    // Only the licence line: no brand at all.
    expect(parse(null, [["the U.S.A. ©1999 NBA Properties, Inc.", 0.91]]).brand).toBeNull();
  });

  it("does not join two stacked words that are not one name", () => {
    const back: Row[] = [["TOPPS", 0.1, 0.1, 0.11, 0.02], ["BASEBALL", 0.125, 0.1, 0.12, 0.02]];
    const p = parse(null, back);
    expect(p.brand).toBe("Topps");
    expect(p.brandSigns).toBe(1);
  });

  it("reads UDC and a misread \"Deck Co\" in the copyright line as Upper Deck", () => {
    expect(parse(null, [["©2022 UDC. 5830 El Camino Real,", 0.89, 0.36, 0.24, 0.02]])).toMatchObject({ brand: "Upper Deck", year: 2022 });
    expect(parse(null, [["©1990 The Cippe Deck Co inprime Aux E U", 0.21]])).toMatchObject({ brand: "Upper Deck", year: 1990 });
    // "DECK" alone outside a copyright line says nothing.
    expect(parse(null, [["ON DECK CIRCLE", 0.5]]).brand).toBeNull();
  });
});

describe("year", () => {
  it("reads a blurred copyright year with an S for the 9 (\"1S8S\")", () => {
    expect(parse(null, [["1S8S TOPPS CHEWING GUM INC PRTD IN U.S.A.", 0.9, 0.2, 0.41, 0.04]]).year).toBe(1985);
  });

  it("season sports: the set year is the first year of the season after the last stat row, the copyright may show the second", () => {
    const back: Row[] = [
      ["YR TEAM", 0.56, 0.2, 0.12, 0.02],
      ["GP FG% FT% RB AST", 0.56, 0.41, 0.25, 0.02],
      ["96-97 BUCKS", 0.61, 0.2, 0.13, 0.02],
      ["97-98 BUCKS", 0.65, 0.2, 0.13, 0.02],
      ["2 NBA TOTALS", 0.7, 0.2, 0.13, 0.02],
      ["Company, LC ©1999 The Upper Deck Company, LL.AllRghts Reserved.", 0.9, 0.33, 0.45, 0.02],
    ];
    expect(parse(null, back)).toMatchObject({ year: 1998, brand: "Upper Deck" });
    // The copyright in the season's first year agrees too.
    const same = back.map((r): Row => (r[0].includes("©") ? ["©1998 The Upper Deck Company", 0.9, 0.33, 0.45, 0.02] : r));
    expect(parse(null, same).year).toBe(1998);
  });

  it("takes one season row as the last season when the totals row is right under it", () => {
    const back: Row[] = [
      ["YEAR", 0.73, 0.34, 0.05, 0.02], ["TEAM", 0.73, 0.41, 0.05, 0.02], ["AVG", 0.73, 0.48, 0.04, 0.02], ["HR", 0.73, 0.68, 0.03, 0.02],
      ["Best Year ATHLETICS", 0.75, 0.34, 0.13, 0.02], [".307", 0.75, 0.47, 0.05, 0.02], ["42", 0.75, 0.68, 0.03, 0.02],
      ["1995", 0.77, 0.34, 0.07, 0.02], ["RED SOX", 0.77, 0.4, 0.06, 0.02], [".306", 0.77, 0.48, 0.04, 0.02], ["24", 0.77, 0.68, 0.03, 0.02],
      ["11-YEAR TOTALS", 0.79, 0.34, 0.13, 0.02], [".271 .351", 0.79, 0.47, 0.1, 0.02], ["300", 0.79, 0.67, 0.04, 0.02],
    ];
    expect(parse(null, back).year).toBe(1996);
    // Without the totals row one season row is not a table.
    expect(parse(null, back.filter((r) => !r[0].includes("TOTALS"))).year).toBeNull();
  });

  it("reads a large short year in a logo on the back, one year after the copyright", () => {
    const back: Row[] = [
      ["55", 0.09, 0.15, 0.05, 0.04],
      ["PROSPECT", 0.17, 0.43, 0.35, 0.05],
      ["©1990 THE UPPER DECK CO PRINTED IN USA", 0.22, 0.17, 0.19, 0.01],
      ["91", 0.22, 0.57, 0.09, 0.06],
      ["T.M.", 0.22, 0.69, 0.04, 0.02],
      ["The Braves were hoping Chipper", 0.32, 0.44, 0.34, 0.02],
      ["Jones was the good hitting", 0.34, 0.44, 0.34, 0.02],
    ];
    expect(parse(null, back)).toMatchObject({ year: 1991, brand: "Upper Deck", cardNumber: "55" });
    // A number in small type, or one standing alone (a jersey in a photo), is not a logo year.
    const small = back.map((r): Row => (r[0] === "91" ? ["91", 0.22, 0.57, 0.03, 0.02] : r));
    expect(parse(null, small).year).toBe(1990);
    const alone = back.map((r): Row => (r[0] === "91" ? ["91", 0.5, 0.57, 0.09, 0.06] : r));
    expect(parse(null, alone).year).toBe(1990);
  });
});

describe("card number", () => {
  it("never takes a jersey number printed with the position", () => {
    const back: Row[] = [
      ["DOUG WIDELL", 0.09, 0.07, 0.17, 0.03],
      ["1991 The Upper Deck Company All rights reserved Printed in the US A", 0.39, 0.13, 0.02, 0.5],
      ["GUARD", 0.64, 0.08, 0.02, 0.1],
      ["#67", 0.66, 0.06, 0.02, 0.06],
    ];
    expect(parse(null, back).cardNumber).toBeNull();
    expect(parse(null, [["GUARD #67", 0.66, 0.6, 0.2, 0.03]]).cardNumber).toBeNull();
    // A "#" number with no position near it is still the card number.
    expect(parse(null, [["#67", 0.66, 0.06, 0.04, 0.03], ["Some words", 0.2]]).cardNumber).toBe("67");
  });
});

describe("first name check", () => {
  const front: Row[] = [["Fose Canseco", 0.06, 0.34, 0.31, 0.04]];
  it("puts a misread first letter right when the card's text names the player with the common name", () => {
    const back: Row[] = [
      ["Fose Canseco", 0.05, 0.33, 0.32, 0.04],
      ["with the Red Sox,", 0.18, 0.08, 0.18, 0.03],
      ["Jose tied a club", 0.22, 0.08, 0.16, 0.03],
    ];
    expect(parse(front, back).player).toBe("Jose Canseco");
  });

  it("leaves the name out when nothing settles it", () => {
    expect(parse(front, [["Fose Canseco", 0.05, 0.33, 0.32, 0.04]]).player).toBeNull();
  });

  it("keeps common names and names far from any common one", () => {
    expect(parse([["Doug Widell", 0.88, 0.11, 0.26, 0.04]], null).player).toBe("Doug Widell");
    expect(parse([["Chipper Jones", 0.84, 0.39, 0.25, 0.04]], null).player).toBe("Chipper Jones");
  });
});

describe("lower case heading", () => {
  const body: Row[] = [["GUARD", 0.13, 0.55, 0.14, 0.03], ["HT:6'5 WT:205", 0.18, 0.56, 0.2, 0.02], ["ALLEN OPENED THE 1998-99", 0.31, 0.57, 0.33, 0.02]];
  it("reads a large heading in lower case at the top of the back as the name when it starts with a common given name", () => {
    expect(parse([["BLYACK", 0.82, 0.64, 0.27, 0.03]], [["ray allen", 0.04, 0.17, 0.29, 0.08], ...body]).player).toBe("Ray Allen");
  });
  it("never takes other lower case words, small ones or ones low on the card", () => {
    expect(parse(null, [["the bucks", 0.04, 0.17, 0.29, 0.08], ...body]).player).toBeNull();
    expect(parse(null, [["ray allen", 0.04, 0.17, 0.29, 0.02], ...body]).player).toBeNull();
    expect(parse(null, [["ray allen", 0.6, 0.17, 0.29, 0.08], ...body]).player).toBeNull();
  });
});
