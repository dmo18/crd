import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogCard } from "./types";
import { parseChecklist } from "./mycardfolio";
import { parseSearch } from "./mycardfolio";
import { allowedDistance, editDistance, firstFits, isSpecial, isSubset, judge, judgeConfirm, matchRead, nameDistance, parseName, slimRows, type NameParts } from "./match";

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

describe("judge against the rows of checklist 9179, taken as a whole set", () => {
  const rows = slimRows(CARDS);
  for (const name of ["Eriffey", "Ken Griffey, J", "KEN GRIFFEY JR"]) {
    it(`"${name}" gives 551033 as sure`, () => {
      const j = judge(rows, matchRead([name], null), "complete");
      expect(j.sure?.sourceId).toBe("551033");
      expect(j.sureBy).toBe("name");
    });
  }
  it("number and name agree: sure by number", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "336"), "complete");
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.sureBy).toBe("number");
    expect(j.sure?.why).toBe("Number and name agree");
  });
  it("a read number that disagrees gives both cards as candidates and no sure card", () => {
    const j = judge(rows, matchRead(["Ken Griffey Jr."], "337"), "complete");
    expect(j.sure).toBeNull();
    const ids = j.candidates.map((c) => c.sourceId);
    expect(ids).toContain("551033");
    expect(ids).toContain(CARDS.find((c) => c.cardNumber === "337")?.sourceId);
  });
  it("an unknown misspelling finds nothing sure", () => {
    expect(judge(rows, matchRead(["Xqzwv"], null), "complete").sure).toBeNull();
  });
});

describe("Griffey Sr. and Griffey Jr. are never confused", () => {
  const rows = slimRows([...CARDS, SENIOR]);
  it("Ken Griffey, J and KEN GRIFFEY JR give the Jr.", () => {
    expect(judge(rows, matchRead(["Ken Griffey, J"], null), "complete").sure?.sourceId).toBe("551033");
    expect(judge(rows, matchRead(["KEN GRIFFEY JR"], null), "complete").sure?.sourceId).toBe("551033");
  });
  it("Ken Griffey Sr. gives the Sr., never the Jr.", () => {
    const j = judge(rows, matchRead(["Ken Griffey Sr."], null), "complete");
    expect(j.sure?.sourceId).toBe("999469");
    expect(j.candidates.map((c) => c.sourceId)).not.toContain("551033");
  });
  it("no suffix read: not sure, both are candidates", () => {
    for (const name of ["Ken Griffey", "Eriffey"]) {
      const j = judge(rows, matchRead([name], null), "complete");
      expect(j.sure).toBeNull();
      expect(j.candidates.map((c) => c.sourceId).slice(0, 2).sort()).toEqual(["551033", "999469"]);
    }
  });
  it("Jr. with the Sr.'s number: no sure card", () => {
    expect(judge(rows, matchRead(["Ken Griffey Jr."], "469"), "complete").sure).toBeNull();
  });
});

describe("special products and noise", () => {
  const tiffany = card({ sourceId: "551885", variation: "Tiffany", sourceSetId: "9181" });
  it("Tiffany is never sure", () => {
    const j = judge(slimRows([tiffany]), matchRead(["Ken Griffey Jr."], "336"), "complete");
    expect(j.sure).toBeNull();
    expect(j.candidates[0].sourceId).toBe("551885");
    expect(j.candidates[0].why).toContain("Tiffany");
  });
  it("Tiffany read as the product is still never sure", () => {
    expect(judge(slimRows([tiffany]), matchRead(["Ken Griffey Jr."], "336"), "complete").sure).toBeNull();
  });
  it("base wins over Tiffany with the same number and name", () => {
    const j = judge(slimRows([tiffany, griffey]), matchRead(["Ken Griffey Jr."], "336"), "search");
    expect(j.sure?.sourceId).toBe("551033");
    expect(j.candidates.map((c) => c.sourceId)).toEqual(["551033", "551885"]);
  });
  it("noise rows are never matched by close spelling", () => {
    const noise = card({ sourceId: "ebay_1", verified: false, sourceSetId: null, player: "Ken Griffey Jr." });
    for (const name of ["Ken Griffey Jr.", "Eriffey"]) {
      const j = judge(slimRows([noise]), matchRead([name], "336"), "complete");
      expect(j.sure).toBeNull();
      expect(j.candidates[0]).toMatchObject({ sourceId: "ebay_1", score: 0, why: "Unverified listing" });
    }
  });
  it("a search answer (not a whole set) is sure only with number and name", () => {
    expect(judge(slimRows([griffey]), matchRead(["Ken Griffey Jr."], null), "search").sure).toBeNull();
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
  const partial = (name: string, number: string | null = null) => judge(rows, matchRead([name], number), "partial");
  it("nothing is sure by name alone, whatever was read", () => {
    for (const name of ["Ken Griffey Jr.", "Eriffey", "Ozzie Smith", "Dwight Smith", "Dave Martinez", "Bo Jackson", "Nolan Ryan", "Kent Anderson", "Mets"]) {
      expect(partial(name).sure, name).toBeNull();
    }
  });
  it("Ozzie Smith, also misread, is only a name to confirm, never the All-Star card #400", () => {
    for (const name of ["Ozzie Smith", "Ozzie Srnith", "0zzie Smith"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.confirm?.player, name).toBe("Ozzie Smith");
      expect(j.candidates[0], name).toMatchObject({ cardNumber: "400", why: expect.stringContaining("All-Star") });
    }
  });
  it("an initial does not pick one Smith or one Martinez: no sure card and nothing to confirm", () => {
    for (const name of ["O Smith", "D Smith", "D Martinez", "D Mart", "Smith", "Martinez"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.confirm, name).toBeNull();
    }
    expect(partial("D Smith").candidates.map((c) => c.cardNumber)).toContain("311");
    expect(partial("D Martinez").candidates.map((c) => c.cardNumber)).toContain("228");
  });
  it("a whole first name picks the player, to be confirmed", () => {
    expect(partial("Dwight Smith").confirm?.cardNumber).toBe("311");
    expect(partial("Dave Martinez").confirm?.cardNumber).toBe("228");
  });
  it("Griffey without the Jr. is never sure here: at most a name to confirm", () => {
    for (const name of ["Ken Griffey", "Griffey", "Griff", "Ken Griff", "Eriffey", "Ken Griffey, J"]) {
      const j = partial(name);
      expect(j.sure, name).toBeNull();
      expect(j.confirm?.sourceId, name).toBe("551033");
    }
  });
  it("Ken Anderson is not Kent Anderson #16", () => {
    const j = partial("Ken Anderson");
    expect(j.sure).toBeNull();
    expect(j.confirm).toBeNull();
    expect(j.candidates.map((c) => c.cardNumber)).not.toContain("16");
  });
  it("Mets is not the Nolan Ryan Salute card #2", () => {
    const j = partial("Mets");
    expect(j.sure).toBeNull();
    expect(j.confirm).toBeNull();
  });
  it("two plain cards of one player in the part we have: not sure, nothing to confirm", () => {
    const j = partial("Rickey Henderson");
    expect(j.sure).toBeNull();
    expect(j.confirm).toBeNull();
    expect(j.candidates.map((c) => c.cardNumber).sort()).toEqual(["450", "7"]);
  });
  it("with the read number, name and number agree and the card is sure, a subset card too", () => {
    expect(partial("Ozzie Smith", "400")).toMatchObject({ sure: { cardNumber: "400" }, sureBy: "number" });
    expect(partial("Ken Griffey", "336")).toMatchObject({ sure: { sourceId: "551033" }, sureBy: "number" });
    expect(partial("Ozzie Smith", "590").sure).toBeNull();
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
  it("a whole set: the plain card wins over the same player's All-Star card, without a number", () => {
    // Kevin Mitchell: #401 All-Star and #500 plain. Mark Davis: #205 plain and #407 All-Star.
    expect(judge(rows, matchRead(["Kevin Mitchell"], null), "complete").sure?.cardNumber).toBe("500");
    expect(judge(rows, matchRead(["Mark Davis"], null), "complete").sure?.cardNumber).toBe("205");
  });
  it("a whole set: a player with only a subset card is a candidate, never sure without the number", () => {
    for (const name of ["Ozzie Smith", "Mets", "Checklist"]) expect(judge(rows, matchRead([name], null), "complete").sure, name).toBeNull();
    expect(judge(rows, matchRead(["Ozzie Smith"], "400"), "complete").sure?.cardNumber).toBe("400");
  });
  it("any variation is never sure, even with number and name", () => {
    for (const variation of ["Tiffany", "Glossy", "Big Baseball", "Traded"]) {
      const v = card({ sourceId: "77", variation });
      expect(isSpecial(v)).toBe(true);
      const j = judge(slimRows([v]), matchRead(["Ken Griffey Jr."], "336"), "complete");
      expect(j.sure, variation).toBeNull();
      expect(j.candidates[0].sourceId).toBe("77");
    }
    // The "No name on front" error version of #414 is a variation too.
    expect(judge(rows, matchRead(["Frank Thomas"], "414"), "complete").sure).toBeNull();
    expect(isSpecial(card({ setName: "All-Star Inserts" }))).toBe(true);
  });
});

describe("the confirm search answer", () => {
  const recorded = (name: string) => slimRows((parseSearch(JSON.stringify(fixture(name).response), 10) ?? []).filter((c) => c.verified && c.brand === "Topps"));
  const ozzieAs = CARDS.find((c) => c.cardNumber === "400") as CatalogCard;
  it("1990 Topps Ozzie Smith (recorded): exactly one plain card in the set, #590, not the All-Star #400", () => {
    const r = judgeConfirm(recorded("search_1990_topps_ozzie_smith.json"), ozzieAs, matchRead(["Ozzie Srnith"], null));
    expect(r.sure).toMatchObject({ sourceId: "551287", cardNumber: "590", variation: null });
    expect(r.candidates.map((c) => c.cardNumber).slice(0, 2)).toEqual(["590", "400"]);
  });
  it("1990 Topps Ken Griffey Jr. (recorded): exactly one plain card in the set, #336", () => {
    const r = judgeConfirm(recorded("search_1990_topps_griffey_jr_confirm.json"), griffey, matchRead(["Ken Griffey, J"], null));
    expect(r.sure?.sourceId).toBe("551033");
  });
  it("more than one plain card of the player in the set: not sure, both stay candidates", () => {
    const second = card({ sourceId: "551999", cardNumber: "700" });
    const r = judgeConfirm(slimRows([griffey, second]), griffey, matchRead(["Ken Griffey"], null));
    expect(r.sure).toBeNull();
    expect(r.candidates.map((c) => c.sourceId)).toEqual(["551033", "551999"]);
  });
  it("only a subset card, only a variation, another set, another player or a listing: not sure", () => {
    const read = matchRead(["Ken Griffey Jr."], null);
    expect(judgeConfirm(slimRows([card({ tags: ["AS"] })]), griffey, read).sure).toBeNull();
    expect(judgeConfirm(slimRows([card({ variation: "Tiffany" })]), griffey, read).sure).toBeNull();
    expect(judgeConfirm(slimRows([card({ sourceSetId: "47027" })]), griffey, read).sure).toBeNull();
    expect(judgeConfirm(slimRows([SENIOR]), griffey, read).sure).toBeNull();
    expect(judgeConfirm(slimRows([card({ verified: false })]), griffey, read).sure).toBeNull();
    expect(judgeConfirm([], griffey, read).sure).toBeNull();
  });
  it("a read number that disagrees with the one card: not sure", () => {
    expect(judgeConfirm(slimRows([griffey]), griffey, matchRead(["Ken Griffey Jr."], "337")).sure).toBeNull();
    expect(judgeConfirm(slimRows([griffey]), griffey, matchRead(["Ken Griffey Jr."], "336")).sure?.sourceId).toBe("551033");
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
    const ms = time(() => judge(rows, read, "complete"));
    console.log(`match timing: slim rows for 500 cards ${prep.toFixed(2)} ms, judge 500 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });
  it("800 names, 5 spellings, under 50 ms", () => {
    const more = CARDS.slice(0, 300).map((c, i) => ({ ...c, sourceId: `9${i}`, cardNumber: String(501 + i), player: `${c.player ?? "Joe Smith"}son` }));
    const rows = slimRows([...CARDS, ...more]);
    expect(rows).toHaveLength(800);
    const read = matchRead(spellings, null);
    const ms = time(() => judge(rows, read, "complete"));
    console.log(`match timing: judge 800 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });
});
