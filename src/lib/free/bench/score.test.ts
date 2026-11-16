import { describe, expect, it } from "vitest";
import { checkBar, markCard, markField, summarize, type Answer, type CardMarks, type Field } from "./score";

const answer: Answer = {
  sport: "baseball", year: 1990, brand: "Topps", setName: "Topps", cardNumber: "336",
  player: "Ken Griffey Jr.", team: "Seattle Mariners",
};

describe("markField", () => {
  it("ignores case and punctuation in text", () => {
    expect(markField("player", "Ken Griffey Jr", "Ken Griffey Jr.")).toBe("right");
    expect(markField("player", "KEN GRIFFEY, JR.", "Ken Griffey Jr.")).toBe("right");
    expect(markField("brand", "topps", "Topps")).toBe("right");
    expect(markField("player", "Ken Griffey Sr", "Ken Griffey Jr.")).toBe("wrong");
  });
  it("marks empty reads blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(markField("player", v, "A B")).toBe("blank");
  });
  it("compares card numbers as trimmed text without a leading #", () => {
    expect(markField("cardNumber", " #336 ", "336")).toBe("right");
    expect(markField("cardNumber", "336", "#336")).toBe("right");
    expect(markField("cardNumber", "337", "336")).toBe("wrong");
    expect(markField("cardNumber", "36", "336")).toBe("wrong");
  });
  it("compares year exactly", () => {
    expect(markField("year", 1990, 1990)).toBe("right");
    expect(markField("year", "1990", 1990)).toBe("right");
    expect(markField("year", 1991, 1990)).toBe("wrong");
  });
  it("accepts the full team or the nickname", () => {
    expect(markField("team", "Seattle Mariners", "Seattle Mariners")).toBe("right");
    expect(markField("team", "seattle mariners", "Seattle Mariners")).toBe("right");
    expect(markField("team", "Mariners", "Seattle Mariners")).toBe("right");
    expect(markField("team", "Seattle", "Seattle Mariners")).toBe("wrong");
    expect(markField("team", "Orioles", "Seattle Mariners")).toBe("wrong");
  });
  it("treats a null answer as should-be-blank", () => {
    expect(markField("team", "Lakers", null)).toBe("wrong");
    expect(markField("team", null, null)).toBe("right");
    expect(markField("team", "", null)).toBe("right");
  });
});

describe("markCard", () => {
  it("marks every field, missing ones blank", () => {
    const m = markCard({ player: "Ken Griffey Jr", year: 1991, team: "Mariners" }, answer);
    expect(m).toEqual({
      sport: "blank", year: "wrong", brand: "blank", setName: "blank", cardNumber: "blank", player: "right", team: "right",
    });
  });
});

function cardOf(over: Partial<CardMarks> = {}): CardMarks {
  return { sport: "right", year: "right", brand: "right", setName: "right", cardNumber: "right", player: "right", team: "right", ...over };
}

describe("summarize", () => {
  it("counts and computes fill and wrong rates", () => {
    const s = summarize([cardOf(), cardOf({ year: "wrong", player: "blank" }), cardOf({ year: "blank", player: "blank" }), cardOf({ player: "blank" })]);
    const year = s.fields.find((f) => f.field === "year")!;
    expect(year).toMatchObject({ cards: 4, right: 2, wrong: 1, blank: 1, filled: 3 });
    expect(year.fillRate).toBeCloseTo(0.75);
    expect(year.wrongRate).toBeCloseTo(1 / 3);
    const player = s.fields.find((f) => f.field === "player")!;
    expect(player.fillRate).toBeCloseTo(0.25);
    expect(player.wrongRate).toBe(0);
    // 28 fields, 3 blank players and 1 blank year
    expect(s.filled).toBe(24);
    expect(s.wrong).toBe(1);
    expect(s.overallWrongRate).toBeCloseTo(1 / 24);
  });
  it("is all zeros for no cards or nothing filled", () => {
    const s = summarize([]);
    expect(s.overallWrongRate).toBe(0);
    expect(s.fields.every((f) => f.fillRate === 0 && f.wrongRate === 0)).toBe(true);
    expect(summarize([cardOf({ sport: "blank" })]).fields[0].wrongRate).toBe(0);
  });
});

describe("checkBar", () => {
  const many = (n: number, f: (i: number) => Partial<CardMarks>) => Array.from({ length: n }, (_, i) => cardOf(f(i)));

  it("passes a clean, well filled run", () => {
    expect(checkBar(summarize(many(10, () => ({})))).pass).toBe(true);
  });
  it("passes at the exact limits", () => {
    // 100 cards: player 90, year 80, brand 80, cardNumber 70 filled; 14 wrong of 700 minus blanks stays under 2 percent
    const cards = many(100, (i) => ({
      setName: i < 10 ? "wrong" : "right",
      player: i < 10 ? "blank" : "right",
      year: i < 20 ? "blank" : "right",
      brand: i < 20 ? "blank" : "right",
      cardNumber: i < 30 ? "blank" : "right",
    }));
    const s = summarize(cards);
    expect(s.overallWrongRate).toBeLessThanOrEqual(0.02);
    expect(checkBar(s)).toEqual({ pass: true, reasons: [] });
  });
  it("fails on wrong rate", () => {
    const r = checkBar(summarize(many(10, (i) => (i < 2 ? { brand: "wrong" as const } : {}))));
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toContain("wrong rate");
  });
  it.each<[Field, number]>([["player", 11], ["year", 21], ["brand", 21], ["cardNumber", 31]])(
    "fails when %s fill rate is just under the minimum",
    (field, blanks) => {
      const r = checkBar(summarize(many(100, (i) => (i < blanks ? { [field]: "blank" as const } : {}))));
      expect(r.pass).toBe(false);
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]).toContain(`${field} fill rate`);
    },
  );
  it("does not hold other fields to a fill rate", () => {
    expect(checkBar(summarize(many(10, () => ({ team: "blank", setName: "blank", sport: "blank" })))).pass).toBe(true);
  });
  it("fails with no cards", () => {
    expect(checkBar(summarize([])).pass).toBe(false);
  });
});
