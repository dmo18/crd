import { describe, expect, it } from "vitest";
import { KEY_CARDS } from "@/lib/free/key-cards";
import { normalizeBrand, normalizeCardNumber } from "@/lib/catalog/normalize";
import { GUIDE_CEILING_CENTS, GUIDE_MISSING, guidePrice, numericGrade, playerTier, printRun, TOO_RARE, type GuideFields } from "./index";
import { findPricedCard, PRICED_CARDS } from "./key-prices";
import { factsFitYear } from "./apply";
import { listedNames, listedTier } from "./players";
import {
  AUTOGRAPH_RANGES, ERAS, GRADE_BANDS, MEMORABILIA_RANGES, PLAYER_TIERS, ROOKIE_MULTIPLIER, SEALED_RANGES, SERIAL_TIERS, type Range,
} from "./tables";

const blank: GuideFields = {
  kind: "card", year: null, yearEnd: null, sport: null, brand: null, setName: null, cardNumber: null, player: null, variation: null,
  isRookie: false, isError: false, isParallel: false, isInsert: false, isAutograph: false, isMemorabilia: false,
  serialNumber: null, serialEdition: null, rarityTier: null, condition: null, grader: null, grade: null,
  productType: null, estCount: null,
};
const card = (f: Partial<GuideFields>) => ({ ...blank, ...f });
const DASHES = new RegExp("[\\u2013\\u2014]");

function ok(item: GuideFields, facts = {}) {
  const p = guidePrice(item, facts);
  if (!p.ok) throw new Error(`expected a guide price, got: ${p.missing}`);
  return p;
}
const valid = (r: Range) => r[0] >= 0 && r[0] <= r[1] && Number.isFinite(r[1]);

describe("guide tables", () => {
  it("has sane ranges that rise with the player tier in every era", () => {
    for (const era of ERAS) {
      let prev: Range = [0, 0];
      for (const t of PLAYER_TIERS) {
        const r = era.base[t];
        expect(valid(r)).toBe(true);
        expect(r[0]).toBeGreaterThanOrEqual(prev[0]);
        expect(r[1]).toBeGreaterThanOrEqual(prev[1]);
        prev = r;
      }
      expect(DASHES.test(era.words)).toBe(false);
    }
    for (const table of [AUTOGRAPH_RANGES, MEMORABILIA_RANGES]) {
      let prev: Range = [0, 0];
      for (const t of PLAYER_TIERS) {
        expect(valid(table[t])).toBe(true);
        expect(table[t][0]).toBeGreaterThanOrEqual(prev[0]);
        prev = table[t];
      }
    }
    for (const t of PLAYER_TIERS) expect(ROOKIE_MULTIPLIER[t]).toBeGreaterThanOrEqual(1);
  });

  it("covers every year from 1900 on without gaps or overlaps", () => {
    for (let y = 1900; y <= 2100; y += 1) expect(ERAS.filter((e) => y >= e.from && y <= e.to)).toHaveLength(1);
    // The overproduced years are the cheapest base cards.
    const junk = ERAS.find((e) => e.from === 1986)!;
    for (const e of ERAS) expect(e.base.common[1]).toBeGreaterThanOrEqual(junk.base.common[1]);
  });

  it("pays more for smaller print runs and higher grades", () => {
    for (let i = 1; i < SERIAL_TIERS.length; i += 1) {
      expect(SERIAL_TIERS[i].upTo).toBeGreaterThan(SERIAL_TIERS[i - 1].upTo);
      expect(SERIAL_TIERS[i].multiplier).toBeLessThanOrEqual(SERIAL_TIERS[i - 1].multiplier);
      expect(SERIAL_TIERS[i].floor[0]).toBeLessThanOrEqual(SERIAL_TIERS[i - 1].floor[0]);
      expect(valid(SERIAL_TIERS[i].floor)).toBe(true);
    }
    for (let i = 1; i < GRADE_BANDS.length; i += 1) {
      expect(GRADE_BANDS[i].from).toBeLessThan(GRADE_BANDS[i - 1].from);
      expect(GRADE_BANDS[i].high).toBeLessThanOrEqual(GRADE_BANDS[i - 1].high);
      expect(GRADE_BANDS[i].low).toBeLessThanOrEqual(GRADE_BANDS[i].high);
    }
    for (const r of Object.values(SEALED_RANGES)) if (r) expect(valid(r)).toBe(true);
  });

  it("has a key card table with valid, wide, unrepeated rows", () => {
    expect(PRICED_CARDS.length).toBeGreaterThanOrEqual(150);
    const seen = new Set<string>();
    for (const c of PRICED_CARDS) {
      const key = [c.sport, c.year, normalizeBrand(c.setName), normalizeCardNumber(c.cardNumber), c.isError].join("|");
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(c.year).toBeGreaterThanOrEqual(1948);
      expect(c.lowCents).toBeGreaterThan(0);
      expect(c.highCents).toBeGreaterThanOrEqual(c.lowCents * 2);
      expect(Number.isInteger(c.lowCents) && Number.isInteger(c.highCents)).toBe(true);
      expect(DASHES.test(c.player + c.setName + c.brand)).toBe(false);
    }
    const mid = PRICED_CARDS.filter((c) => c.year >= 1980 && c.year <= 1995).length;
    expect(mid / PRICED_CARDS.length).toBeGreaterThan(0.5);
    for (const s of ["baseball", "basketball", "football", "hockey"]) expect(PRICED_CARDS.some((c) => c.sport === s)).toBe(true);
  });

  it("uses the same card numbers as the recognition list where both list a card", () => {
    for (const k of KEY_CARDS) {
      const priced = PRICED_CARDS.find((c) => c.year === k.year && c.setName === k.setName && c.player === k.player && c.isError === k.isError);
      if (priced) expect(priced.cardNumber).toBe(k.cardNumber);
    }
  });

  it("has about 150 unrepeated player names", () => {
    const names = listedNames();
    expect(names.length).toBeGreaterThanOrEqual(140);
    const keys = names.map((n) => `${n.sport}|${n.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(listedTier("Ken Griffey Jr.", "baseball")).toBe("great");
    expect(listedTier("josé canseco", null)).toBe("star");
    expect(listedTier("Bo Jackson", null)).toBeNull(); // listed in two sports
    expect(listedTier("Wayne Gretzky", "baseball")).toBeNull();
  });
});

describe("the guide's ceiling (review fix 9)", () => {
  it("a graded one of one autograph of a great stops at 25,000 dollars and says to check real sales", () => {
    const r = guidePrice(card({
      year: 2018, brand: "Topps", cardNumber: "US1", player: "Mike Trout", sport: "baseball", isAutograph: true, isMemorabilia: true,
      serialNumber: "1/1", serialEdition: "1", grader: "PSA", grade: "10",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.highCents).toBe(GUIDE_CEILING_CENTS);
    expect(r.lowCents).toBeLessThanOrEqual(GUIDE_CEILING_CENTS);
    expect(r.valueCents).toBeLessThanOrEqual(GUIDE_CEILING_CENTS);
    expect(r.reason.startsWith(TOO_RARE)).toBe(true);
    expect(r.trust).toBe("Very rough");
  });

  it("a card under the ceiling has no such line", () => {
    const r = guidePrice(card({ year: 1990, brand: "Donruss", player: "Joe Nobody", cardNumber: "512" }));
    expect(r.ok && r.reason).not.toContain(TOO_RARE);
  });
});

describe("listed players by their years", () => {
  it("every listed name has playing years that make sense", () => {
    for (const n of listedNames()) {
      expect(n.first, n.name).toBeGreaterThanOrEqual(1890);
      if (n.last != null) expect(n.last, n.name).toBeGreaterThanOrEqual(n.first);
    }
  });

  it("a common card of a same-name player from other years is not the listed player", () => {
    // Frank Thomas the 1950s outfielder, Randy Johnson the early 1980s infielder.
    expect(listedTier("Frank Thomas", "baseball", 1955)).toBeNull();
    expect(listedTier("Frank Thomas", "baseball", 1991)).toBe("hof");
    expect(listedTier("Randy Johnson", "baseball", 1982)).toBeNull();
    expect(listedTier("Randy Johnson", "baseball", 1989)).toBe("hof");
    // Bob Gibson the 1980s Brewers pitcher, after the Hall of Famer's career.
    expect(listedTier("Bob Gibson", "baseball", 1985)).toBeNull();
    expect(listedTier("Bob Gibson", "baseball", 1968)).toBe("hof");
    // Reggie Jackson the basketball player, when the card's sport is not known.
    expect(listedTier("Reggie Jackson", null, 2015)).toBeNull();
    expect(listedTier("Reggie Jackson", "baseball", 2015)).toBe("hof");
    expect(listedTier("Reggie Jackson", null, 1977)).toBe("hof");
    // Bill Russell the Dodgers shortstop, with no sport read.
    expect(listedTier("Bill Russell", null, 1978)).toBeNull();
    expect(listedTier("Bill Russell", "basketball", 1978)).toBe("great");
  });

  it("father and son, and players who share a surname, are never mixed up", () => {
    expect(listedTier("Ken Griffey", "baseball", 1976)).toBeNull();
    expect(listedTier("Ken Griffey Sr.", "baseball", 1990)).toBeNull();
    expect(listedTier("Ken Griffey Jr.", "baseball", 1980)).toBeNull();
    expect(listedTier("Ken Griffey Jr.", "baseball", 1989)).toBe("great");
    expect(listedTier("Cal Ripken Sr.", "baseball", 1988)).toBeNull();
    expect(listedTier("Cal Ripken Jr.", "baseball", 1975)).toBeNull();
    expect(listedTier("Cal Ripken Jr.", "baseball", 1982)).toBe("great");
    expect(listedTier("Bobby Bonds", "baseball", 1975)).toBeNull();
    expect(listedTier("Barry Bonds", "baseball", 1975)).toBeNull();
    expect(listedTier("Barry Bonds", "baseball", 1987)).toBe("star");
    // A card made long after the career still counts (no namesake then).
    expect(listedTier("Babe Ruth", "baseball", 2020)).toBe("great");
    expect(listedTier("Vladimir Guerrero", "baseball", 2005)).toBe("hof");
    expect(listedTier("Vladimir Guerrero", "baseball", 2021)).toBeNull();
  });

  it("the guide prices a 1955 Frank Thomas as a common card", () => {
    const old = guidePrice(card({ year: 1955, brand: "Topps", cardNumber: "100", player: "Frank Thomas", sport: "baseball" }));
    const hurt = guidePrice(card({ year: 1991, brand: "Topps", cardNumber: "999", player: "Frank Thomas", sport: "baseball" }));
    expect(old.ok && old.tier).toBe("common");
    expect(hurt.ok && hurt.tier).toBe("hof");
  });

  it("stored Wikidata facts count only for a card from after the player was about 16 and near his first seasons", () => {
    const facts = { birthYear: 1968, careerStart: 1990 };
    expect(factsFitYear(facts, 1955)).toBe(false);
    expect(factsFitYear(facts, 1983)).toBe(false);
    expect(factsFitYear(facts, 1986)).toBe(false);
    expect(factsFitYear(facts, 1988)).toBe(true);
    expect(factsFitYear({ birthYear: 1968, careerStart: null }, 1983)).toBe(false);
    expect(factsFitYear({ birthYear: 1968, careerStart: null }, 1984)).toBe(true);
    expect(factsFitYear({ birthYear: null, careerStart: null }, 1900)).toBe(true);
  });
});

describe("guide rules on concrete cards", () => {
  const cases: { name: string; item: GuideFields; facts?: { hallOfFame?: boolean }; tier: string; brackets: number; maxHigh?: number; trust?: string }[] = [
    { name: "1990 Donruss common", item: card({ year: 1990, brand: "Donruss", player: "Joe Nobody", cardNumber: "512" }), tier: "common", brackets: 10, maxHigh: 25, trust: "Low" },
    { name: "1988 Topps common by number only", item: card({ year: 1988, brand: "Topps", cardNumber: "77" }), tier: "common", brackets: 5, maxHigh: 25, trust: "Very rough" },
    { name: "1989 Upper Deck #1 Griffey", item: card({ year: 1989, brand: "Upper Deck", setName: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", isRookie: true, sport: "baseball" }), tier: "key_card", brackets: 8000, trust: "Low" },
    { name: "1986 Fleer Jordan", item: card({ year: 1986, brand: "Fleer", cardNumber: "57", player: "Michael Jordan", sport: "basketball" }), tier: "key_card", brackets: 300000 },
    { name: "1984 Topps Marino", item: card({ year: 1984, brand: "Topps", cardNumber: "123", player: "Dan Marino" }), tier: "key_card", brackets: 6000 },
    { name: "1984 Topps Elway", item: card({ year: 1984, brand: "Topps", cardNumber: "63", player: "John Elway" }), tier: "key_card", brackets: 6000 },
    { name: "1979 O-Pee-Chee Gretzky", item: card({ year: 1979, brand: "O-Pee-Chee", cardNumber: "18", player: "Wayne Gretzky" }), tier: "key_card", brackets: 300000 },
    { name: "1993 SP Jeter, brand Upper Deck", item: card({ year: 1993, brand: "Upper Deck", setName: "SP", cardNumber: "279", player: "Derek Jeter" }), tier: "key_card", brackets: 20000 },
    { name: "1993 SP Jeter, brand SP", item: card({ year: 1993, brand: "SP", cardNumber: "279", player: "Derek Jeter" }), tier: "key_card", brackets: 20000 },
    { name: "1989 Fleer Bill Ripken error", item: card({ year: 1989, brand: "Fleer", cardNumber: "616", player: "Bill Ripken", isError: true }), tier: "key_card", brackets: 2500 },
    { name: "1990 Topps Thomas no name error", item: card({ year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas", isError: true, variation: "No name on front" }), tier: "key_card", brackets: 150000 },
    { name: "1990 Topps Thomas plain", item: card({ year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas", isRookie: true }), tier: "key_card", brackets: 700 },
    { name: "1982 Topps Traded Ripken", item: card({ year: 1982, brand: "Topps", setName: "Topps Traded", cardNumber: "98T", player: "Cal Ripken Jr." }), tier: "key_card", brackets: 12000 },
    { name: "1990 Topps Nolan Ryan base", item: card({ year: 1990, brand: "Topps", cardNumber: "1", player: "Nolan Ryan", sport: "baseball" }), tier: "great", brackets: 150, trust: "Low" },
    { name: "1991 Fleer Hall of Famer from Wikidata", item: card({ year: 1991, brand: "Fleer", cardNumber: "300", player: "Someone Famous" }), facts: { hallOfFame: true }, tier: "hof", brackets: 75 },
    { name: "1991 Score star from the rarity mark", item: card({ year: 1991, brand: "Score", cardNumber: "5", player: "A Star", rarityTier: "star" }), tier: "star", brackets: 30 },
    { name: "1992 Upper Deck common rookie", item: card({ year: 1992, brand: "Upper Deck", cardNumber: "20", player: "Joe Prospect", isRookie: true }), tier: "common", brackets: 10, maxHigh: 100 },
    { name: "1975 Topps common", item: card({ year: 1975, brand: "Topps", cardNumber: "400", player: "Joe Seventies" }), tier: "common", brackets: 100 },
    { name: "1955 Topps common", item: card({ year: 1955, brand: "Topps", cardNumber: "100", player: "Joe Fifties" }), tier: "common", brackets: 800, trust: "Very rough" },
    { name: "1990 Topps Tiffany common", item: card({ year: 1990, brand: "Topps", setName: "Tiffany", cardNumber: "100", player: "Joe Nobody", isParallel: true }), tier: "common", brackets: 30 },
    { name: "2021 Prizm common", item: card({ year: 2021, brand: "Panini", setName: "Prizm", cardNumber: "100", player: "Joe Modern" }), tier: "common", brackets: 30 },
    { name: "Modern /99 numbered common", item: card({ year: 2020, brand: "Topps", setName: "Chrome", cardNumber: "5", player: "Joe Modern", serialEdition: "99", isParallel: true }), tier: "common", brackets: 500, trust: "Very rough" },
    { name: "Modern /10 autograph of a common", item: card({ year: 2022, brand: "Topps", cardNumber: "A-5", player: "Joe Modern", isAutograph: true, serialNumber: "03/10" }), tier: "common", brackets: 3000 },
    { name: "Modern memorabilia of a Hall of Famer", item: card({ year: 2005, brand: "Upper Deck", cardNumber: "J-1", player: "Wade Boggs", isMemorabilia: true, sport: "baseball" }), tier: "hof", brackets: 3000 },
    { name: "PSA 10 junk wax common", item: card({ year: 1990, brand: "Donruss", cardNumber: "512", player: "Joe Nobody", grader: "PSA", grade: "10" }), tier: "common", brackets: 1200, trust: "Very rough" },
    { name: "PSA 9 Griffey Upper Deck", item: card({ year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", grader: "PSA", grade: "9" }), tier: "key_card", brackets: 15000 },
    { name: "Poor condition Marino", item: card({ year: 1984, brand: "Topps", cardNumber: "123", player: "Dan Marino", condition: "poor" }), tier: "key_card", brackets: 500 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const p = ok(c.item, c.facts);
      expect(p.tier).toBe(c.tier);
      expect(p.lowCents).toBeLessThanOrEqual(c.brackets);
      expect(p.highCents).toBeGreaterThanOrEqual(c.brackets);
      expect(p.lowCents).toBeLessThanOrEqual(p.valueCents);
      expect(p.valueCents).toBeLessThanOrEqual(p.highCents);
      for (const n of [p.lowCents, p.highCents, p.valueCents]) expect(Number.isInteger(n) && n >= 1).toBe(true);
      if (c.maxHigh != null) expect(p.highCents).toBeLessThanOrEqual(c.maxHigh);
      if (c.trust) expect(p.trust).toBe(c.trust);
      expect(["Low", "Very rough"]).toContain(p.trust);
      expect(p.basis.startsWith(`Trust: ${p.trust}. `)).toBe(true);
      expect(p.basis).toContain("not real sales");
      expect(DASHES.test(p.basis)).toBe(false);
      expect(/\bAI\b/.test(p.basis)).toBe(false);
    });
  }

  it("writes the reason from the rule that applied", () => {
    expect(ok(cases[0].item).reason).toMatch(/^Common card from 1990, a year with very large print runs\./);
    expect(ok(card({ year: 1990, brand: "Donruss", cardNumber: "2", player: "Wade Boggs", sport: "baseball" })).reason)
      .toMatch(/^Hall of Fame player, base card from 1990/);
    expect(ok(cases[2].item).reason).toMatch(/^Known key card: 1989 Upper Deck #1\./);
  });

  it("puts a modern /10 autograph far above a base card, and a gem mint copy above a raw one", () => {
    const base = ok(card({ year: 2022, brand: "Topps", cardNumber: "5", player: "Joe Modern" }));
    const auto10 = ok(cases.find((c) => c.name.includes("/10"))!.item);
    expect(auto10.lowCents).toBeGreaterThan(base.highCents * 10);
    const raw = ok(cases[2].item);
    const gem = ok({ ...cases[2].item, grader: "PSA", grade: "10" });
    expect(gem.lowCents).toBeGreaterThan(raw.lowCents);
    expect(gem.highCents).toBeGreaterThan(raw.highCents);
  });

  it("does not match the error version unless the card is marked as an error", () => {
    const plain = ok(card({ year: 1989, brand: "Fleer", cardNumber: "616", player: "Bill Ripken" }));
    expect(plain.tier).toBe("common");
    expect(plain.highCents).toBeLessThan(100);
  });

  it("refuses a key card match when the player disagrees", () => {
    expect(findPricedCard({ year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Joe Nobody" })).toBeNull();
    expect(findPricedCard({ year: 1989, brand: "upper deck", cardNumber: "#001" })?.player).toBe("Ken Griffey Jr.");
    expect(findPricedCard({ year: 1982, brand: "Topps", setName: "Traded", cardNumber: "98-T" })?.player).toBe("Cal Ripken Jr.");
    expect(findPricedCard({ year: 1986, brand: "Fleer", cardNumber: "57", sport: "baseball" })).toBeNull();
  });

  it("says plainly what is missing when the card is too unclear", () => {
    expect(guidePrice(card({ brand: "Topps", player: "Ken Griffey Jr." }))).toEqual({ ok: false, missing: GUIDE_MISSING.year });
    expect(guidePrice(card({ year: 1990, brand: "Topps" }))).toEqual({ ok: false, missing: GUIDE_MISSING.playerOrNumber });
  });

  it("prices only plain sealed product and counted bulk lots", () => {
    const box = guidePrice(card({ kind: "sealed", year: 1990, brand: "Topps", productType: "box", sport: "baseball" }));
    expect(box.ok && box.trust === "Very rough" && box.lowCents >= 500).toBe(true);
    expect(guidePrice(card({ kind: "sealed", year: 1989, brand: "Upper Deck", productType: "box", sport: "baseball" })).ok).toBe(false);
    expect(guidePrice(card({ kind: "sealed", year: 1979, brand: "Topps", productType: "pack" })).ok).toBe(false);
    const lot = guidePrice(card({ kind: "bulk", year: 1988, estCount: 1000 }));
    expect(lot.ok && lot.lowCents === 500 && lot.highCents === 2000).toBe(true);
    expect(guidePrice(card({ kind: "bulk", year: 1988 }))).toEqual({ ok: false, missing: GUIDE_MISSING.bulkCount });
  });

  it("reads tiers, print runs and grades", () => {
    expect(playerTier({ player: "Joe", sport: null, rarityTier: null })).toBe("common");
    expect(playerTier({ player: "Joe", sport: null, rarityTier: null }, { hallOfFame: true })).toBe("hof");
    expect(playerTier({ player: "Michael Jordan", sport: "basketball", rarityTier: "minor_star" }, { hallOfFame: true })).toBe("great");
    expect(printRun({ serialEdition: null, serialNumber: "045/100" })).toBe(100);
    expect(printRun({ serialEdition: "5", serialNumber: null })).toBe(5);
    expect(printRun({ serialEdition: null, serialNumber: null })).toBeNull();
    expect(numericGrade("Gem Mint 10")).toBe(10);
    expect(numericGrade("9.5")).toBe(9.5);
    expect(numericGrade("Authentic")).toBeNull();
  });
});
