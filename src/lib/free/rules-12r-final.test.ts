import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText } from "./parse";

/**
 * 12R final review: one line is one sign, and a surname that is also an
 * everyday word is a sign only where it is written as a name. Made-up cards
 * (boxes as fractions of the card).
 */

/** [text, y, x, w, h] */
type Row = [string, number, number?, number?, number?];

function side(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y, x = 0.1, w = 0.6, h = 0.03]) => ({ text, confidence: 0.95, box: { x, y, w, h } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9 };
}
const parse = (front: Row[] | null, back: Row[] | null) => parseCardText(front ? side(front) : null, back ? side(back) : null);

describe("a holder label line is one sign", () => {
  const label: Row[] = [["1997 UPPER DECK", 0.04, 0.1, 0.5, 0.03], ["PSA", 0.04, 0.8, 0.1, 0.03], ["GEM MT 10", 0.08, 0.7, 0.2, 0.03]];

  it("the label alone fills year and brand, neither sure", () => {
    const p = parse(label, null);
    expect(p).toMatchObject({ year: 1997, brand: "Upper Deck", grader: "PSA" });
    expect(p.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
  });

  it("the label read with the back photo alone is not sure either", () => {
    const p = parse(null, label);
    expect(p).toMatchObject({ year: 1997, brand: "Upper Deck" });
    expect(p.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
  });

  it("another line that agrees makes the field sure", () => {
    const p = parse(label, [["© 1997 THE UPPER DECK COMPANY", 0.95, 0.1, 0.8, 0.02]]);
    expect(p).toMatchObject({ year: 1997, brand: "Upper Deck" });
    expect(p.certainty).toMatchObject({ year: "sure", brand: "sure" });
  });

  it("a season label alone is not sure either", () => {
    const p = parse([["2003-04 UPPER DECK", 0.04, 0.1, 0.5, 0.03], ["PSA", 0.04, 0.8, 0.1, 0.03], ["GEM MT 10", 0.08, 0.7, 0.2, 0.03]], null);
    expect(p).toMatchObject({ year: 2003, brand: "Upper Deck" });
    expect(p.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
  });
});

describe("the card number from one line is one sign", () => {
  it("a lone #336 in a top corner of the back is filled, not sure", () => {
    const p = parse(null, [["#336", 0.03, 0.82, 0.1, 0.03], ["KEN GRIFFEY JR.", 0.08, 0.3, 0.4, 0.04]]);
    expect(p.cardNumber).toBe("336");
    expect(p.certainty.cardNumber).toBe("unsure");
  });

  it("a lone #336 in a bottom corner is one sign too", () => {
    const p = parse(null, [["#336", 0.95, 0.82, 0.1, 0.03], ["KEN GRIFFEY JR.", 0.08, 0.3, 0.4, 0.04]]);
    expect(p.cardNumber).toBe("336");
    expect(p.certainty.cardNumber).toBe("unsure");
  });

  it("the corner and the front's marker on two lines agree: sure", () => {
    const p = parse([["NO. 336", 0.9, 0.1, 0.2, 0.03]], [["336", 0.03, 0.85, 0.08, 0.03], ["KEN GRIFFEY JR.", 0.08, 0.3, 0.4, 0.04]]);
    expect(p.cardNumber).toBe("336");
    expect(p.certainty.cardNumber).toBe("sure");
  });
});

describe("a surname echo must be the name, not an everyday word", () => {
  const front: Row[] = [["STEVE YOUNG", 0.9, 0.3, 0.4, 0.05]];

  it("'the young passer' is not a second sign for Steve Young", () => {
    const p = parse(front, [["The young passer led the league in", 0.3, 0.1, 0.8, 0.03]]);
    expect(p.player).toBe("Steve Young");
    expect(p.certainty.player).toBe("unsure");
  });

  it("'Young' starting a sentence proves nothing alone, but does beside the given name", () => {
    expect(parse(front, [["Young led the league in passing", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
    expect(parse(front, [["Steve Young led the league in passing", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("sure");
  });

  it("'Young' inside a sentence is the name", () => {
    expect(parse(front, [["In 1992 Young led the league in passing", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("sure");
  });

  it("'will' as a word is not a sign for Will Clark; 'Clark' is", () => {
    const f: Row[] = [["WILL CLARK", 0.9, 0.3, 0.4, 0.05]];
    expect(parse(f, [["He will be the first baseman to beat", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
    expect(parse(f, [["Will hit .333 with 29 doubles", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
    expect(parse(f, [["Clark hit .333 with 29 doubles", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("sure");
  });

  it("a surname in lower case is not the name", () => {
    expect(parse([["MARK GRACE", 0.9, 0.3, 0.4, 0.05]], [["with grace and power at the plate", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
  });

  it("an all capitals heading counts for a plain surname, not for an everyday word alone", () => {
    expect(parse([["MARK GRACE", 0.9, 0.3, 0.4, 0.05]], [["GRACE'S BIG YEAR AT FIRST", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("sure");
    expect(parse(front, [["YOUNG GUNS OF THE LEAGUE", 0.3, 0.1, 0.8, 0.03]]).certainty.player).toBe("unsure");
  });
});
