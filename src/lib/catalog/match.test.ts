import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogCard } from "./types";
import { parseChecklist } from "./mycardfolio";
import { allowedDistance, editDistance, firstFits, judge, matchRead, nameDistance, parseName, slimRows, type NameParts } from "./match";

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8"));
}
function checklist9179(): CatalogCard[] {
  const r = parseChecklist(JSON.stringify(fixture("checklist_9179_first500.json").response), "9179");
  if (!r) throw new Error("checklist fixture did not parse");
  return r.cards;
}
const CARDS = checklist9179();
const griffey = CARDS.find((c) => c.sourceId === "551033") as CatalogCard;
/** A Ken Griffey Sr. card in the same set (not in the recording's first 500), to prove the two are never confused. */
const SENIOR: CatalogCard = { ...griffey, sourceId: "999469", cardNumber: "469", player: "Ken Griffey Sr.", url: "https://mycardfolio.com/sports/baseball/1990/topps-2129/base-set-9179/469-ken-griffey-sr-999469" };
function card(over: Partial<CatalogCard>): CatalogCard {
  return { ...griffey, ...over };
}
function p(name: string): NameParts {
  const n = parseName(name);
  if (!n) throw new Error(name);
  return n;
}

describe("names", () => {
  it("parses suffixes and a cut off Jr", () => {
    expect(parseName("KEN GRIFFEY JR")).toEqual({ first: "ken", surname: "griffey", suffix: "jr", suffixCut: null });
    expect(parseName("Ken Griffey, J")).toEqual({ first: "ken", surname: "griffey", suffix: null, suffixCut: "jr" });
    expect(parseName("Eriffey")).toEqual({ first: null, surname: "eriffey", suffix: null, suffixCut: null });
    expect(parseName("Ken Griffey Sr.")?.suffix).toBe("sr");
    expect(parseName("J")).toBeNull();
  });
  it("allowed distance by surname length", () => {
    expect([2, 3, 4, 7, 8, 12].map(allowedDistance)).toEqual([0, 0, 1, 1, 2, 2]);
  });
  it("edit distance: swap 1, reading mix-ups one half, early stop", () => {
    expect(editDistance("griffey", "girffey", 2)).toBe(1);
    expect(editDistance("8onds", "bonds", 2)).toBe(0.5);
    expect(editDistance("rlpken", "ripken", 2)).toBe(0.5);
    expect(editDistance("thornas", "thomas", 2)).toBe(0.5);
    expect(editDistance("smith", "srnith", 2)).toBe(0.5);
    expect(editDistance("eriffey", "griffey", 2)).toBe(1);
    expect(editDistance("ab", "abcdefgh", 2)).toBe(Infinity);
    expect(editDistance("griffey", "mcgriff", 1)).toBe(Infinity);
  });
  it("a three letter surname needs an exact match", () => {
    expect(nameDistance(p("Rov"), p("Patrick Roy"), 0)).toBe(Infinity);
    expect(nameDistance(p("Roy"), p("Patrick Roy"), 0)).toBe(0);
    expect(nameDistance(p("Royy"), p("Patrick Roy"), allowedDistance(3))).toBe(Infinity);
  });
  it("Kevin does not fit Ken; K and Ken do", () => {
    expect(firstFits("kevin", "ken")).toBe(false);
    expect(firstFits("k", "ken")).toBe(true);
    expect(firstFits("ken", "ken")).toBe(true);
    expect(nameDistance(p("Kevin Griffey"), p("Ken Griffey Jr."), 1)).toBe(Infinity);
  });
  it("Jr and Sr never fit each other", () => {
    expect(nameDistance(p("Ken Griffey Jr"), p("Ken Griffey Sr."), 3)).toBe(Infinity);
    expect(nameDistance(p("Ken Griffey, J"), p("Ken Griffey Sr."), 3)).toBe(Infinity);
    expect(nameDistance(p("Ken Griffey Sr"), p("Ken Griffey Jr."), 3)).toBe(Infinity);
  });
  it("a surname cut off at the edge counts one half", () => {
    expect(nameDistance(p("Ken Griff"), p("Ken Griffey Jr."), 1)).toBe(0.5);
  });
});

describe("judge against checklist 9179 (first 500)", () => {
  const rows = slimRows(CARDS);
  for (const name of ["Eriffey", "Ken Griffey, J", "KEN GRIFFEY JR"]) {
    it(`"${name}" gives 551033 as sure`, () => {
      const j = judge(rows, matchRead([name], null), true);
      expect(j.sure?.sourceId).toBe("551033");
      expect(j.sureBy).toBe("name");
    });
  }
  it("number and name agree: sure by number", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "336"), true);
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.sureBy).toBe("number");
    expect(j.sure?.why).toBe("Number and name agree");
  });
  it("a read number that disagrees gives both cards as candidates and no sure card", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "337"), true);
    expect(j.sure).toBeNull();
    const ids = j.candidates.map((c) => c.sourceId);
    expect(ids).toContain("551033");
    expect(ids).toContain(CARDS.find((c) => c.cardNumber === "337")?.sourceId);
  });
  it("an unknown misspelling finds nothing sure", () => {
    expect(judge(rows, matchRead(["Xqzwv"], null), true).sure).toBeNull();
  });
});

describe("Griffey Sr. and Griffey Jr. are never confused", () => {
  const rows = slimRows([...CARDS, SENIOR]);
  it("Ken Griffey, J and KEN GRIFFEY JR give the Jr.", () => {
    expect(judge(rows, matchRead(["Ken Griffey, J"], null), true).sure?.sourceId).toBe("551033");
    expect(judge(rows, matchRead(["KEN GRIFFEY JR"], null), true).sure?.sourceId).toBe("551033");
  });
  it("Ken Griffey Sr. gives the Sr., never the Jr.", () => {
    const j = judge(rows, matchRead(["Ken Griffey Sr."], null), true);
    expect(j.sure?.sourceId).toBe("999469");
    expect(j.candidates.map((c) => c.sourceId)).not.toContain("551033");
  });
  it("no suffix read: not sure, both are candidates", () => {
    for (const name of ["Ken Griffey", "Eriffey"]) {
      const j = judge(rows, matchRead([name], null), true);
      expect(j.sure).toBeNull();
      expect(j.candidates.map((c) => c.sourceId).slice(0, 2).sort()).toEqual(["551033", "999469"]);
    }
  });
  it("Jr. with the Sr.'s number: no sure card", () => {
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "469"), true).sure).toBeNull();
  });
});

describe("special products and noise", () => {
  const tiffany = card({ sourceId: "551885", variation: "Tiffany", sourceSetId: "9181" });
  it("Tiffany is never sure", () => {
    const j = judge(slimRows([tiffany]), matchRead(["Ken Griffey Jr."], "336"), true);
    expect(j.sure).toBeNull();
    expect(j.candidates[0].sourceId).toBe("551885");
    expect(j.candidates[0].why).toContain("Tiffany");
  });
  it("Tiffany read as the product is still never sure", () => {
    expect(judge(slimRows([tiffany], ["toppstiffany"]), matchRead(["Ken Griffey Jr."], "336"), true).sure).toBeNull();
  });
  it("base wins over Tiffany with the same number and name", () => {
    const j = judge(slimRows([tiffany, griffey]), matchRead(["Ken Griffey Jr."], "336"), false);
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.candidates.map((c) => c.sourceId)).toEqual(["551033", "551885"]);
  });
  it("noise rows are never matched by close spelling", () => {
    const noise = card({ sourceId: "ebay_1", verified: false, sourceSetId: null, player: "Ken Griffey Jr." });
    for (const name of ["Ken Griffey Jr.", "Eriffey"]) {
      const j = judge(slimRows([noise]), matchRead([name], "336"), true);
      expect(j.sure).toBeNull();
      expect(j.candidates[0]).toMatchObject({ sourceId: "ebay_1", score: 0, why: "Unverified listing" });
    }
  });
  it("a search answer (not a whole set) is sure only with number and name", () => {
    expect(judge(slimRows([griffey]), matchRead(["Ken Griffey Jr."], null), false).sure).toBeNull();
  });
});

describe("the 31 trial cards with their damaged spellings", () => {
  const trial = fixture("trial-cards.json").cards as { player: string; damaged: string }[];
  it("has 31 cards", () => expect(trial).toHaveLength(31));
  for (const t of trial) {
    const truth = p(t.player);
    const short = truth.surname.length <= 3;
    it(`${t.damaged} ${short ? "does not fit" : "fits"} ${t.player}`, () => {
      const d = nameDistance(p(t.damaged), truth, allowedDistance(truth.surname.length));
      if (short) expect(d).toBe(Infinity);
      else expect(d).toBeLessThanOrEqual(allowedDistance(truth.surname.length));
    });
  }
});

describe("speed on this server", () => {
  function median(xs: number[]) {
    return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  }
  function time(fn: () => void): number {
    fn();
    const runs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    return median(runs);
  }
  const spellings = ["Eriffey", "Ken Griffey, J", "KEN GRIFFEY JR", "K Grifey", "Griffcy"];
  it("500 row checklist: turned into slim rows once, then 5 spellings under 50 ms", () => {
    const prep = time(() => slimRows(CARDS));
    const rows = slimRows(CARDS);
    const read = matchRead(spellings, null);
    const ms = time(() => judge(rows, read, true));
    console.log(`match timing: slim rows for 500 cards ${prep.toFixed(2)} ms, judge 500 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });
  it("800 names, 5 spellings, under 50 ms", () => {
    const more = CARDS.slice(0, 300).map((c, i) => ({ ...c, sourceId: `9${i}`, cardNumber: String(501 + i), player: `${c.player ?? "Joe Smith"}son` }));
    const rows = slimRows([...CARDS, ...more]);
    expect(rows).toHaveLength(800);
    const read = matchRead(spellings, null);
    const ms = time(() => judge(rows, read, true));
    console.log(`match timing: judge 800 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });
});
