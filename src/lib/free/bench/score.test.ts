import { describe, expect, it } from "vitest";
import { checkBar, countFiled, markCard, markField, summarize, sureMarks, type Answer, type CardMarks, type Field, type Filed } from "./score";

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
  it("counts a set read by its first words, or with words more, as right", () => {
    expect(markField("setName", "Select", "Select Draft Picks")).toBe("right");
    expect(markField("setName", "Black Diamond Double", "Black Diamond")).toBe("right");
    expect(markField("setName", "Sel", "Select Draft Picks")).toBe("wrong");
    expect(markField("setName", "Draft Picks", "Select Draft Picks")).toBe("wrong");
    expect(markField("setName", "Prizm", "Select")).toBe("wrong");
  });
  it("ignores accents in names", () => {
    expect(markField("player", "Alvaro Morata", "\u00c1lvaro Morata")).toBe("right");
    expect(markField("player", "Ronald Acu\u00f1a Jr.", "Ronald Acuna Jr.")).toBe("right");
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

describe("sure fields", () => {
  it("counts only the fields the reader was sure of", () => {
    const marks = cardOf({ year: "wrong", team: "blank" });
    expect(sureMarks(marks, { player: "sure", year: "unsure", brand: "sure", team: "sure" })).toEqual({
      sport: "blank", year: "blank", brand: "right", setName: "blank", cardNumber: "blank", player: "right", team: "blank",
    });
    expect(sureMarks(cardOf({ year: "wrong" }), { year: "sure" }).year).toBe("wrong");
  });
  it("gives the sure table: fill = sure fields / cards, wrong among sure fields", () => {
    const cards = [
      sureMarks(cardOf(), { player: "sure", year: "sure" }),
      sureMarks(cardOf({ year: "wrong" }), { player: "sure", year: "sure" }),
      sureMarks(cardOf(), { player: "unsure" }),
      sureMarks(cardOf(), {}),
    ];
    const s = summarize(cards);
    const player = s.fields.find((f) => f.field === "player")!;
    expect(player.fillRate).toBeCloseTo(0.5);
    const year = s.fields.find((f) => f.field === "year")!;
    expect(year.wrongRate).toBeCloseTo(0.5);
    expect(s.filled).toBe(4);
    expect(s.wrong).toBe(1);
  });
  it("counts cards filed on their own and those of them with any field wrong", () => {
    expect(countFiled([
      { marks: cardOf(), filed: true },
      { marks: cardOf({ team: "wrong" }), filed: true },
      { marks: cardOf({ year: "wrong" }), filed: false },
    ])).toEqual({ cards: 3, filed: 2, filedWrong: 1 });
    expect(countFiled([])).toEqual({ cards: 0, filed: 0, filedWrong: 0 });
  });
});

describe("checkBar", () => {
  const many = (n: number, f: (i: number) => Partial<CardMarks>) => Array.from({ length: n }, (_, i) => cardOf(f(i)));
  const none: Filed = { cards: 0, filed: 0, filedWrong: 0 };
  const bar = (all: CardMarks[], sure: CardMarks[] = all, filed: Filed = none) => checkBar(summarize(all), summarize(sure), filed);

  it("passes a clean, well filled run", () => {
    expect(bar(many(10, () => ({}))).pass).toBe(true);
  });
  it("passes at the exact limits", () => {
    // 100 cards, all sure: player 70, year 60, brand 60, cardNumber 50 filled; 7 wrong sets, under 2 in 100 of the sure fields
    const sure = many(100, (i) => ({
      setName: i < 7 ? "wrong" : "right",
      player: i < 30 ? "blank" : "right",
      year: i < 40 ? "blank" : "right",
      brand: i < 40 ? "blank" : "right",
      cardNumber: i < 50 ? "blank" : "right",
    }));
    const s = summarize(sure);
    expect(s.overallWrongRate).toBeLessThanOrEqual(0.02);
    expect(checkBar(s, s, { cards: 100, filed: 40, filedWrong: 0 })).toEqual({ pass: true, reasons: [] });
  });
  it("fails on the sure wrong rate", () => {
    const r = bar(many(10, (i) => (i < 2 ? { brand: "wrong" as const } : {})));
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toContain("sure wrong rate");
  });
  it("fails on the wrong rate of all filled fields, unsure ones too", () => {
    // 10 cards, 70 fields: 6 wrong unsure fields is over 8 in 100; the sure ones are clean.
    const all = many(10, (i) => (i < 6 ? { team: "wrong" as const } : {}));
    const sure = many(10, () => ({ team: "blank" as const }));
    const r = bar(all, sure);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("all filled fields");
    // 5 wrong (7 in 100) passes.
    expect(bar(many(10, (i) => (i < 5 ? { team: "wrong" as const } : {})), sure).pass).toBe(true);
  });
  it("fails when a card filed on its own has a wrong field", () => {
    const r = bar(many(10, () => ({})), many(10, () => ({})), { cards: 10, filed: 3, filedWrong: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain("filed on their own");
  });
  it.each<[Field, number]>([["player", 31], ["year", 41], ["brand", 41], ["cardNumber", 51]])(
    "fails when the sure %s fill rate is just under the minimum",
    (field, blanks) => {
      const all = many(100, () => ({}));
      const r = bar(all, many(100, (i) => (i < blanks ? { [field]: "blank" as const } : {})));
      expect(r.pass).toBe(false);
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]).toContain(`${field} sure fill rate`);
    },
  );
  it("does not hold other fields to a fill rate", () => {
    expect(bar(many(10, () => ({ team: "blank", setName: "blank", sport: "blank" }))).pass).toBe(true);
  });
  it("fails with no cards", () => {
    expect(bar([]).pass).toBe(false);
  });
});
