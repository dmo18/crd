import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogCard } from "./types";
import { parseChecklist } from "./mycardfolio";
import { allowedDistance, editDistance, firstFits, foldOcr, isSpecial, isSubset, judge, matchRead, nameDistance, parseName, slimRow, slimRows, type NameParts, type SureGate } from "./match";

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
/** Base set 9179 confirmed by its checklist, as lookup proves it. */
const BASE: SureGate = { baseSetIds: ["9179"] };
function p(name: string): NameParts {
  const n = parseName(name);
  if (!n) throw new Error(name);
  return n;
}

describe("names", () => {
  it("parses suffixes and a cut off Jr", () => {
    expect(parseName("KEN GRIFFEY JR")).toEqual({ first: "ken", surname: "griffey", suffix: "jr", suffixCut: null, lastWord: "griffey" });
    expect(parseName("Ken Griffey, J")).toEqual({ first: "ken", surname: "griffey", suffix: null, suffixCut: "jr", lastWord: "griffey" });
    expect(parseName("Eriffey")).toEqual({ first: null, surname: "eriffey", suffix: null, suffixCut: null, lastWord: "eriffey" });
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

describe("judge against the rows of checklist 9179 (10.6f: no sure by name, not even in a complete set)", () => {
  const rows = slimRows(CARDS);
  for (const name of ["Eriffey", "Ken Griffey, J", "KEN GRIFFEY JR"]) {
    it(`"${name}" with no number: not sure, 551033 is the top candidate`, () => {
      const j = judge(rows, matchRead([name], null), BASE);
      expect(j).toMatchObject({ sure: null, sureBy: null });
      expect(j.candidates[0].sourceId).toBe("551033");
    });
  }
  it("number, first name and surname agree in the confirmed base set: sure", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "336"), BASE);
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.sureBy).toBe("number");
    expect(j.sure?.why).toBe("Number and name agree");
  });
  it("no gate (nothing proven by lookup): never sure", () => {
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "336")).sure).toBeNull();
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "336"), null).sure).toBeNull();
  });
  it("a read number that disagrees gives both cards as candidates and no sure card", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "337"), BASE);
    expect(j.sure).toBeNull();
    const ids = j.candidates.map((c) => c.sourceId);
    expect(ids).toContain("551033");
    expect(ids).toContain(CARDS.find((c) => c.cardNumber === "337")?.sourceId);
  });
  it("an unknown misspelling finds nothing sure", () => {
    expect(judge(rows, matchRead(["Xqzwv"], null), BASE).sure).toBeNull();
  });
});

describe("Griffey Sr. and Griffey Jr. are never confused", () => {
  const rows = slimRows([...CARDS, SENIOR]);
  it("with no number nothing is sure; the Jr. leads for Ken Griffey, J and KEN GRIFFEY JR", () => {
    for (const name of ["Ken Griffey, J", "KEN GRIFFEY JR"]) {
      const j = judge(rows, matchRead([name], null), BASE);
      expect(j.sure, name).toBeNull();
      expect(j.candidates[0].sourceId, name).toBe("551033");
    }
  });
  it("Ken Griffey Sr. leads with the Sr., never the Jr.", () => {
    const j = judge(rows, matchRead(["Ken Griffey Sr."], null), BASE);
    expect(j.sure).toBeNull();
    expect(j.candidates[0].sourceId).toBe("999469");
    expect(j.candidates.map((c) => c.sourceId)).not.toContain("551033");
  });
  it("no suffix read: not sure, both are candidates", () => {
    for (const name of ["Ken Griffey", "Eriffey"]) {
      const j = judge(rows, matchRead([name], null), BASE);
      expect(j.sure).toBeNull();
      expect(j.candidates.map((c) => c.sourceId).slice(0, 2).sort()).toEqual(["551033", "999469"]);
    }
  });
  it("Jr. with the Sr.'s number: no sure card", () => {
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "469"), BASE).sure).toBeNull();
  });
  it("both Griffeys in the pool: even number, first name, surname and suffix read are not sure (the first name does not tell them apart)", () => {
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "336"), BASE).sure).toBeNull();
    expect(judge(rows, matchRead(["Ken Griffey Sr."], "469"), BASE).sure).toBeNull();
  });
});

describe("special products and noise", () => {
  const tiffany = card({ sourceId: "551885", variation: "Tiffany", sourceSetId: "9181" });
  it("Tiffany is never sure", () => {
    const j = judge(slimRows([tiffany]), matchRead(["Ken Griffey Jr."], "336"), { baseSetIds: ["9179", "9181"] });
    expect(j.sure).toBeNull();
    expect(j.candidates[0].sourceId).toBe("551885");
    expect(j.candidates[0].why).toContain("Tiffany");
  });
  it("Tiffany read as the product is still never sure", () => {
    expect(judge(slimRows([tiffany]), matchRead(["Ken Griffey Jr."], "336"), BASE).sure).toBeNull();
  });
  it("base wins over Tiffany with the same number and name", () => {
    const j = judge(slimRows([tiffany, griffey]), matchRead(["Ken Griffey Jr."], "336"), BASE);
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.candidates.map((c) => c.sourceId)).toEqual(["551033", "551885"]);
  });
  it("noise rows are never matched by close spelling", () => {
    const noise = card({ sourceId: "ebay_1", verified: false, sourceSetId: null, player: "Ken Griffey Jr." });
    for (const name of ["Ken Griffey Jr.", "Eriffey"]) {
      const j = judge(slimRows([noise]), matchRead([name], "336"), BASE);
      expect(j.sure).toBeNull();
      expect(j.candidates[0]).toMatchObject({ sourceId: "ebay_1", score: 0, why: "Unverified listing" });
    }
  });
  it("a single row is sure only with the number read", () => {
    expect(judge(slimRows([griffey]), matchRead(["Ken Griffey Jr."], null), BASE).sure).toBeNull();
    expect(judge(slimRows([griffey]), matchRead(["Ken Griffey Jr."], "336"), BASE).sure?.sourceId).toBe("551033");
  });
});

describe("first names: a prefix only for an initial or a read under 3 letters", () => {
  it("Ken never fits Kent, Kent never fits Ken", () => {
    expect(firstFits("ken", "kent")).toBe(false);
    expect(firstFits("kent", "ken")).toBe(false);
    expect(firstFits("kenneth", "ken")).toBe(false);
    expect(nameDistance(p("Ken Anderson"), p("Kent Anderson"), 3)).toBe(Infinity);
  });
  it("an initial, two letters, the exact name and a close spelling fit", () => {
    expect(firstFits("k", "kent")).toBe(true);
    expect(firstFits("ke", "kent")).toBe(true);
    expect(firstFits("kent", "kent")).toBe(true);
    expect(firstFits("0zzie", "ozzie")).toBe(true);
    expect(firstFits("dwlght", "dwight")).toBe(true);
    expect(firstFits("d", "ozzie")).toBe(false);
  });
});

describe("a checklist that was cut short (9179: the first 500 of 792)", () => {
  const rows = slimRows(CARDS);
  const partial = (name: string, number: string | null = null) => judge(rows, matchRead([name], number), BASE);
  it("nothing is sure by name alone, whatever was read, even a name that stands alone", () => {
    for (const name of ["Ken Griffey Jr.", "Eriffey", "Ozzie Smith", "Dwight Smith", "Dave Martinez", "Bo Jackson", "Nolan Ryan", "Kent Anderson", "Mets", "Randy Johnson", "Kevin Mitchell"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.sureBy, name).toBeNull();
    }
  });
  it('"Ken Griffey", "Griffey", "Ken Griffey, J", "Ken Griffey Jr." and close spellings: not sure, #336 is the top candidate', () => {
    for (const name of ["Ken Griffey", "Griffey", "Ken Griffey, J", "Ken Griffey Jr.", "Griff", "Ken Griff", "Eriffey"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.candidates[0]?.sourceId, name).toBe("551033");
    }
  });
  it("Ozzie Smith, also misread, is not sure and never the All-Star card #400 as sure; #400 is a candidate", () => {
    for (const name of ["Ozzie Smith", "Ozzie Srnith", "0zzie Smith"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.candidates[0], name).toMatchObject({ cardNumber: "400", why: expect.stringContaining("All-Star") });
    }
  });
  it("an initial does not pick one Smith or one Martinez; the card it resembles stays a candidate", () => {
    for (const name of ["O Smith", "D Smith", "D Martinez", "D Mart", "Smith", "Martinez"]) expect(partial(name).sure, name).toBeNull();
    expect(partial("D Smith").candidates.map((c) => c.cardNumber)).toContain("311");
    expect(partial("D Martinez").candidates.map((c) => c.cardNumber)).toContain("228");
  });
  it("Ken Anderson is not Kent Anderson #16", () => {
    const j = partial("Ken Anderson");
    expect(j.sure).toBeNull();
    expect(j.candidates.map((c) => c.cardNumber)).not.toContain("16");
  });
  it("Mets is not the Nolan Ryan Salute card #2", () => {
    expect(partial("Mets").sure).toBeNull();
  });
  it("two plain cards of one player: not sure, both candidates", () => {
    const j = partial("Rickey Henderson");
    expect(j.sure).toBeNull();
    expect(j.candidates.map((c) => c.cardNumber).sort()).toEqual(["450", "7"]);
  });
  it("with the read number 336, only the exact whole name is sure; no first name, no suffix, a cut suffix or a close surname is not", () => {
    expect(partial("Ken Griffey Jr.", "336")).toMatchObject({ sure: { sourceId: "551033" }, sureBy: "number" });
    for (const name of ["Ken Griffey", "Griffey", "Ken Griffey, J", "K Griffey Jr.", "Eriffey", "Ken Griff", "Ken Grifey"]) {
      const j = partial(name, "336");
      expect(j.sure, name).toBeNull();
      expect(j.candidates[0]?.sourceId, name).toBe("551033");
    }
    expect(partial("Dwight Smith", "311")).toMatchObject({ sure: { cardNumber: "311" }, sureBy: "number" });
  });
  it("a read number with a subset card (All-Star #400) is a candidate only, never sure", () => {
    const j = partial("Ozzie Smith", "400");
    expect(j.sure).toBeNull();
    expect(j.candidates[0].cardNumber).toBe("400");
    expect(partial("Ozzie Smith", "590").sure).toBeNull();
  });
});

describe("bracketed qualifiers and players of the same name", () => {
  const davePitcher = CARDS.find((c) => c.cardNumber === "416") as CatalogCard;
  const daveManager = CARDS.find((c) => c.cardNumber === "291") as CatalogCard;
  const jeffM = CARDS.find((c) => c.cardNumber === "42") as CatalogCard;
  /** A second Jeff Robinson of the set, past the recording's first 500. */
  const JEFF_D: CatalogCard = { ...jeffM, sourceId: "999723", cardNumber: "723", player: "Jeff D. Robinson", url: "https://mycardfolio.com/sports/baseball/1990/topps-2129/base-set-9179/723-jeff-d-robinson-999723" };
  it("drops (P) and (Texas) before parsing, so the row has a name", () => {
    expect(davePitcher.player).toBe("Dave Johnson (P)");
    expect(parseName("DAVE JOHNSON (P)")).toEqual({ first: "dave", surname: "johnson", suffix: null, suffixCut: null, lastWord: "johnson" });
    expect(parseName("Jeff Robinson (Texas)")).toEqual({ first: "jeff", surname: "robinson", suffix: null, suffixCut: null, lastWord: "robinson" });
    expect(parseName("Ken Griffey Jr. (Mariners")?.suffix).toBe("jr");
    expect(parseName("(P)")).toBeNull();
    expect(slimRow(davePitcher).playerKey).toBe(slimRow(daveManager).playerKey);
    expect(slimRow(jeffM).playerKey).toBe("jeff|robinson|");
    expect(slimRow(griffey).playerKey).not.toBe(slimRow(SENIOR).playerKey);
  });
  it('"Dave Johnson" with no number is not sure: #291 and #416 both fit', () => {
    const j = judge(slimRows(CARDS), matchRead(["Dave Johnson"], null), BASE);
    expect(j.sure).toBeNull();
    expect(j.candidates.map((c) => c.cardNumber).slice(0, 2).sort()).toEqual(["291", "416"]);
  });
  it('"Jeff Robinson" is not sure when #42 and #723 are both in the set, not even with the number (same first name)', () => {
    const rows = slimRows([...CARDS, JEFF_D]);
    for (const name of ["Jeff Robinson", "Robinson", "J Robinson"]) {
      const j = judge(rows, matchRead([name], null), BASE);
      expect(j.sure, name).toBeNull();
      expect(j.candidates.map((c) => c.cardNumber), name).toEqual(expect.arrayContaining(["42", "723"]));
    }
    expect(judge(rows, matchRead(["Jeff Robinson"], "723"), BASE).sure).toBeNull();
    expect(judge(rows, matchRead(["Jeff Robinson"], "42"), BASE).sure).toBeNull();
  });
  it("a player alone in the set is not sure by name alone; with the number read he is", () => {
    expect(judge(slimRows(CARDS), matchRead(["Randy Johnson"], null), BASE).sure).toBeNull();
    const n = CARDS.find((c) => c.player === "Randy Johnson")?.cardNumber ?? null;
    expect(judge(slimRows(CARDS), matchRead(["Randy Johnson"], n), BASE)).toMatchObject({ sure: { player: "Randy Johnson" }, sureBy: "number" });
  });
});

describe("subset cards and variations", () => {
  const rows = slimRows(CARDS);
  it("knows the subset cards of 1990 Topps", () => {
    const subset = (n: string) => isSubset(CARDS.find((c) => c.cardNumber === n) as CatalogCard);
    expect(["2", "5", "6", "128", "314", "385", "400", "407"].map(subset)).toEqual(Array(8).fill(true));
    expect(["1", "16", "228", "300", "311", "336", "500"].map(subset)).toEqual(Array(7).fill(false));
    for (const words of ["Turn Back the Clock 1985", "Future Stars", "Team Leaders", "Record Breaker", "Highlights", "Top Prospects", "#1 Draft Pick"]) {
      expect(isSubset(card({ player: `Someone ${words}` })), words).toBe(true);
    }
    expect(isSubset(card({ otherPlayers: ["Someone Else"] }))).toBe(true);
  });
  it("the plain card ranks over the same player's All-Star card; without a number neither is sure", () => {
    // Kevin Mitchell: #401 All-Star and #500 plain. Mark Davis: #205 plain and #407 All-Star.
    const kevin = judge(rows, matchRead(["Kevin Mitchell"], null), BASE);
    expect(kevin.sure).toBeNull();
    expect(kevin.candidates[0].cardNumber).toBe("500");
    expect(judge(rows, matchRead(["Mark Davis"], null), BASE).candidates[0].cardNumber).toBe("205");
    // The same player's All-Star card is no rival: with the number, the plain card is sure.
    expect(judge(rows, matchRead(["Kevin Mitchell"], "500"), BASE).sure?.cardNumber).toBe("500");
  });
  it("a player with only a subset card is a candidate, never sure, even with the number", () => {
    for (const name of ["Ozzie Smith", "Mets", "Checklist"]) expect(judge(rows, matchRead([name], null), BASE).sure, name).toBeNull();
    const j = judge(rows, matchRead(["Ozzie Smith"], "400"), BASE);
    expect(j.sure).toBeNull();
    expect(j.candidates[0].cardNumber).toBe("400");
  });
  it("any variation is never sure, even with number and name", () => {
    for (const variation of ["Tiffany", "Glossy", "Big Baseball", "Traded"]) {
      const v = card({ sourceId: "77", variation });
      expect(isSpecial(v)).toBe(true);
      const j = judge(slimRows([v]), matchRead(["Ken Griffey Jr."], "336"), BASE);
      expect(j.sure, variation).toBeNull();
      expect(j.candidates[0].sourceId).toBe("77");
    }
    // The "No name on front" error version of #414 is a variation too.
    expect(judge(rows, matchRead(["Frank Thomas"], "414"), BASE).sure).toBeNull();
    expect(isSpecial(card({ setName: "All-Star Inserts" }))).toBe(true);
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
  it("500 row checklist: turned into slim rows once, then 5 spellings under 20 ms", () => {
    const prep = time(() => slimRows(CARDS));
    const rows = slimRows(CARDS);
    const read = matchRead(spellings, null);
    const ms = time(() => judge(rows, read, BASE));
    console.log(`match timing: slim rows for 500 cards ${prep.toFixed(2)} ms, judge 500 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50); // plan limit; measured about 7 ms when the server is quiet
  });
  it("800 names, 5 spellings, under 20 ms", () => {
    const more = CARDS.slice(0, 300).map((c, i) => ({ ...c, sourceId: `9${i}`, cardNumber: String(501 + i), player: `${c.player ?? "Joe Smith"}son` }));
    const rows = slimRows([...CARDS, ...more]);
    expect(rows).toHaveLength(800);
    const read = matchRead(spellings, null);
    const ms = time(() => judge(rows, read, BASE));
    console.log(`match timing: judge 800 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50); // plan limit; measured about 7 ms when the server is quiet
  });
});

describe("third and fourth review: particles, folding and the one strict sure case", () => {
  it("particles join the surname only in a name of three or more words; in two words the first word is the first name", () => {
    expect(parseName("De La Cruz")).toEqual({ first: null, surname: "delacruz", suffix: null, suffixCut: null, lastWord: "cruz" });
    expect(parseName("Elly De La Cruz")).toMatchObject({ first: "elly", surname: "delacruz", lastWord: "cruz" });
    expect(parseName("Randy St. Claire")).toMatchObject({ first: "randy", surname: "stclaire" });
    expect(parseName("Tony La Russa")).toMatchObject({ first: "tony", surname: "larussa" });
    expect(parseName("Mark Mc Gwire Jr")).toMatchObject({ first: "mark", surname: "mcgwire", suffix: "jr" });
    expect(parseName("Paul O'Neill")).toMatchObject({ first: "paul", surname: "oneill" });
    expect(parseName("Von Hayes")).toMatchObject({ first: "von", surname: "hayes" });
    expect(parseName("Von Miller")).toMatchObject({ first: "von", surname: "miller" });
    expect(parseName("Del Ennis")).toMatchObject({ first: "del", surname: "ennis" });
    expect(parseName("St. Claire")).toMatchObject({ first: "st", surname: "claire" });
    expect(parseName("La Russa")).toMatchObject({ first: "la", surname: "russa" });
    expect(parseName("Ken Griffey Jr.")).toMatchObject({ first: "ken", surname: "griffey", suffix: "jr" });
    expect(nameDistance(p("De La Cruz"), p("Deivi Cruz"), 3)).toBe(Infinity);
  });
  it("folding forgives only the reading mix-ups", () => {
    expect(foldOcr("wltt")).toBe(foldOcr("witt"));
    expect(foldOcr("srnith")).toBe(foldOcr("smith"));
    expect(foldOcr("8onds")).toBe(foldOcr("bonds"));
    expect(foldOcr("eriffey")).not.toBe(foldOcr("griffey"));
    expect(foldOcr("williamson")).not.toBe(foldOcr("williams"));
  });
  const rows = slimRows(CARDS);
  it("number path: a close surname is not sure (Williamson #41, Costello #427), an exact or folded whole name is", () => {
    for (const [name, number] of [["Williamson", "41"], ["Costello", "427"], ["Eriffey", "336"]] as const) {
      expect(judge(rows, matchRead([name], number), BASE).sure, name).toBeNull();
    }
    expect(judge(rows, matchRead(["Matt Williams"], "41"), BASE).sure?.cardNumber).toBe("41");
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "336"), BASE).sure?.sourceId).toBe("551033");
    expect(judge(rows, matchRead(["Dwlght Srnith"], "311"), BASE).sure?.cardNumber).toBe("311");
  });
  it("number path: an initial or no first name is never sure, even alone in the pool", () => {
    const senior581 = card({ sourceId: "999581", cardNumber: "581", player: "Ken Griffey Sr." });
    const both = slimRows([...CARDS, senior581]);
    expect(judge(both, matchRead(["Griffey"], "581"), BASE).sure).toBeNull();
    expect(judge(both, matchRead(["K Griffey"], "581"), BASE).sure).toBeNull();
    expect(judge(both, matchRead(["Kevin Griffey"], "336"), BASE).sure).toBeNull();
    expect(judge(slimRows([senior581]), matchRead(["Griffey"], "581"), BASE).sure).toBeNull();
    expect(judge(slimRows([senior581]), matchRead(["Ken Griffey Sr."], "581"), BASE).sure?.sourceId).toBe("999581");
  });
  it("a sure card must come from the confirmed base set: none or another set gives no sure card", () => {
    const read = matchRead(["Ken Griffey Jr."], "336");
    expect(judge(rows, read, BASE).sure?.sourceId).toBe("551033");
    expect(judge(rows, read, { baseSetIds: [] }).sure).toBeNull();
    expect(judge(rows, read, { baseSetIds: ["9999"] }).sure).toBeNull();
    const other = card({ sourceId: "999336", sourceSetId: "9999" });
    const j = judge(slimRows([other, griffey]), read, BASE);
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.candidates.map((c) => c.sourceId)).toContain("999336");
  });

  describe("fourth review cases: all NOT sure", () => {
    const vonHayes = card({ sourceId: "990710", cardNumber: "710", player: "Von Hayes" });
    const charlieHayes = card({ sourceId: "990577", cardNumber: "577", player: "Charlie Hayes" });
    const hayes = slimRows([...CARDS, vonHayes, charlieHayes]);
    it('"Hayes" with or without #577 when Von Hayes #710 and Charlie Hayes #577 are in the pool', () => {
      for (const n of [null, "577", "710"]) {
        const j = judge(hayes, matchRead(["Hayes"], n), BASE);
        expect(j.sure, String(n)).toBeNull();
        expect(j.candidates.map((c) => c.sourceId), String(n)).toEqual(expect.arrayContaining(n === "710" ? ["990710"] : ["990577"]));
      }
    });
    it('"V. Hayes" #710 is not sure (initial only); "Von Hayes" #710 and "Charlie Hayes" #577 are, the first names tell them apart', () => {
      expect(judge(hayes, matchRead(["V. Hayes"], "710"), BASE).sure).toBeNull();
      expect(judge(hayes, matchRead(["C Hayes"], "577"), BASE).sure).toBeNull();
      expect(judge(hayes, matchRead(["Von Hayes"], "710"), BASE).sure?.sourceId).toBe("990710");
      expect(judge(hayes, matchRead(["Charlie Hayes"], "577"), BASE).sure?.sourceId).toBe("990577");
    });
    it("a surname whose last word equals it is a rival too (Bob De La Hayes)", () => {
      const pool = slimRows([charlieHayes, card({ sourceId: "990720", cardNumber: "720", player: "Bob De La Hayes" })]);
      expect(judge(pool, matchRead(["Charlie Hayes"], "577"), BASE).sure?.sourceId).toBe("990577");
      const noFirst = slimRows([charlieHayes, card({ sourceId: "990721", cardNumber: "721", player: "De La Hayes" })]);
      expect(judge(noFirst, matchRead(["Charlie Hayes"], "577"), BASE).sure).toBeNull();
    });
    it('"Miller" (Bob and Von Miller) and "Ennis" (Jim and Del Ennis), with or without the number', () => {
      const pool = slimRows([
        card({ sourceId: "990601", cardNumber: "601", player: "Bob Miller" }),
        card({ sourceId: "990602", cardNumber: "602", player: "Von Miller" }),
        card({ sourceId: "990603", cardNumber: "603", player: "Jim Ennis" }),
        card({ sourceId: "990604", cardNumber: "604", player: "Del Ennis" }),
      ]);
      for (const [name, numbers] of [["Miller", [null, "601", "602"]], ["Ennis", [null, "603", "604"]]] as const) {
        for (const n of numbers) expect(judge(pool, matchRead([name], n), BASE).sure, `${name} ${n}`).toBeNull();
      }
    });
    it('a 2-card clean set: a name alone is not sure', () => {
      const pool = slimRows([card({ sourceId: "990001", cardNumber: "1", player: "Alan Able" }), card({ sourceId: "990002", cardNumber: "2", player: "Bert Baker" })]);
      for (const name of ["Alan Able", "Able", "Bert Baker"]) expect(judge(pool, matchRead([name], null), BASE).sure, name).toBeNull();
    });
    it('"Jim Thorne" #801 is not sure when Jim Thome is in the pool (rn folds to m)', () => {
      const pool = slimRows([...CARDS, card({ sourceId: "990801", cardNumber: "801", player: "Jim Thorne" }), card({ sourceId: "990811", cardNumber: "811", player: "Jim Thome" })]);
      expect(judge(pool, matchRead(["Jim Thorne"], "801"), BASE).sure).toBeNull();
      expect(judge(pool, matchRead(["Jim Thome"], "811"), BASE).sure).toBeNull();
    });
    it('"Joe Hall" #803 is not sure when Joe Hail is in the pool (i folds to l); Mel and Drew Hall are told apart', () => {
      const joeHall = card({ sourceId: "990803", cardNumber: "803", player: "Joe Hall" });
      const pool = slimRows([...CARDS, joeHall, card({ sourceId: "990813", cardNumber: "813", player: "Joe Hail" })]);
      expect(judge(pool, matchRead(["Joe Hall"], "803"), BASE).sure).toBeNull();
      // Without Joe Hail, the other Halls of 9179 (Mel #436, Drew #463) have other first names.
      expect(judge(slimRows([...CARDS, joeHall]), matchRead(["Joe Hall"], "803"), BASE).sure?.sourceId).toBe("990803");
    });
    it('"Ozzie Smith" #805 is not sure with a row "Smith" with no first name in the pool, nor when the card itself has no first name', () => {
      const ozzie = card({ sourceId: "990805", cardNumber: "805", player: "Ozzie Smith" });
      const bare = card({ sourceId: "990806", cardNumber: "806", player: "Smith" });
      expect(judge(slimRows([...CARDS, ozzie, bare]), matchRead(["Ozzie Smith"], "805"), BASE).sure).toBeNull();
      expect(judge(slimRows([...CARDS, ozzie]), matchRead(["Ozzie Smith"], "805"), BASE).sure?.sourceId).toBe("990805");
      expect(judge(slimRows([card({ sourceId: "990807", cardNumber: "807", player: "Smith" })]), matchRead(["Ozzie Smith"], "807"), BASE).sure).toBeNull();
    });
    it("rivals passed by lookup (answers seen outside the judged rows) block sure too", () => {
      const rival = slimRows([card({ sourceId: "990469", cardNumber: "469", player: "Ken Griffey Sr.", year: 1989 })]);
      expect(judge(rows, matchRead(["Ken Griffey Jr."], "336"), { baseSetIds: ["9179"], rivals: rival }).sure).toBeNull();
    });
  });
});
