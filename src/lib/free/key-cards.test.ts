import { describe, expect, it } from "vitest";
import { RARITY_TIERS, SPORTS } from "@/db/schema";
import { findKeyCard, KEY_CARDS, keyCardsFor, normalizeBrand, normalizeCardNumber, normalizeName } from "./key-cards";

describe("key card list", () => {
  it("has no repeated cards", () => {
    const keys = KEY_CARDS.map((k) => [k.sport, k.year, k.brand, k.setName, k.cardNumber, k.variation ?? ""].join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only lists cards from 1980 to 1995 with valid fields", () => {
    expect(KEY_CARDS.length).toBeGreaterThan(90);
    for (const k of KEY_CARDS) {
      expect(k.year).toBeGreaterThanOrEqual(1980);
      expect(k.year).toBeLessThanOrEqual(1995);
      expect(SPORTS).toContain(k.sport);
      expect(RARITY_TIERS).toContain(k.tier);
      expect(["star", "key", "grail"]).toContain(k.tier);
      expect(k.brand.trim()).toBe(k.brand);
      expect(k.brand.length).toBeGreaterThan(0);
      expect(k.setName.length).toBeGreaterThan(0);
      expect(k.cardNumber).toMatch(/^[A-Z]?-?\d{1,3}[A-Z]?$/);
      expect(k.player).toMatch(/^[A-Z][A-Za-z.' ]+$/);
      expect(k.note.length).toBeGreaterThan(10);
      expect(k.note).not.toMatch(/\$|\d+ dollars/i);
      if (k.isError) expect(k.variation).not.toBeNull();
    }
  });

  it("has no em dash or en dash anywhere", () => {
    for (const k of KEY_CARDS) {
      for (const v of Object.values(k)) {
        if (typeof v === "string") expect(v).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it("covers all four main sports", () => {
    for (const s of ["baseball", "basketball", "football", "hockey"] as const) {
      expect(KEY_CARDS.some((k) => k.sport === s)).toBe(true);
    }
  });
});

describe("normalizers", () => {
  it("normalizes brands and names", () => {
    expect(normalizeBrand("O-Pee-Chee")).toBe("opeechee");
    expect(normalizeBrand(" upper  DECK ")).toBe("upperdeck");
    expect(normalizeName("Ken Griffey Jr.")).toBe("ken griffey jr");
    expect(normalizeName("SHAQUILLE O'NEAL")).toBe("shaquille oneal");
    expect(normalizeName("Jarom\u00edr J\u00e1gr")).toBe("jaromir jagr");
    expect(normalizeCardNumber("U-27")).toBe(normalizeCardNumber("27u"));
    expect(normalizeCardNumber("098T")).toBe("T98");
  });
});

describe("findKeyCard", () => {
  it("finds the 1989 Upper Deck Griffey by number and by name", () => {
    const byNumber = findKeyCard({ year: 1989, brand: "upper deck", cardNumber: "#1" });
    expect(byNumber?.player).toBe("Ken Griffey Jr.");
    expect(byNumber?.tier).toBe("grail");
    const byName = findKeyCard({ year: 1989, brand: "Upper Deck", player: "KEN GRIFFEY JR" });
    expect(byName?.cardNumber).toBe("1");
  });

  it("finds the 1986 Fleer Jordan", () => {
    const k = findKeyCard({ year: 1986, brand: "FLEER", cardNumber: "57", sport: "basketball" });
    expect(k?.player).toBe("Michael Jordan");
    expect(k?.isRookie).toBe(true);
  });

  it("returns the plain Frank Thomas for 1990 Topps 414 and lists the no name error too", () => {
    const k = findKeyCard({ year: 1990, brand: "Topps", cardNumber: "414" });
    expect(k?.player).toBe("Frank Thomas");
    expect(k?.isError).toBe(false);
    const err = KEY_CARDS.find((c) => c.year === 1990 && c.cardNumber === "414" && c.isError);
    expect(err?.variation).toBe("No name on front");
    expect(err?.tier).toBe("grail");
  });

  it("finds error cards that have only one listing", () => {
    const ripken = findKeyCard({ year: 1989, brand: "Fleer", cardNumber: "616" });
    expect(ripken?.player).toBe("Bill Ripken");
    expect(ripken?.isError).toBe(true);
  });

  it("matches traded numbers written either way", () => {
    expect(findKeyCard({ year: 1982, brand: "Topps", cardNumber: "T98" })?.player).toBe("Cal Ripken Jr.");
    expect(findKeyCard({ year: 1984, brand: "Fleer", cardNumber: "U27" })?.player).toBe("Roger Clemens");
  });

  it("falls back to the player when the number is not listed", () => {
    const k = findKeyCard({ year: 1984, brand: "Donruss", cardNumber: "999", player: "Don Mattingly" });
    expect(k?.cardNumber).toBe("248");
  });

  it("returns null when nothing matches", () => {
    expect(findKeyCard({ year: 1990, brand: "Topps", cardNumber: "1" })).toBeNull();
    expect(findKeyCard({ year: 1990, brand: "Topps", player: "Nobody Special" })).toBeNull();
    expect(findKeyCard({ brand: "Topps", cardNumber: "414" })).toBeNull();
    expect(findKeyCard({ year: 1990, cardNumber: "414" })).toBeNull();
    expect(findKeyCard({})).toBeNull();
    expect(findKeyCard({ year: 1990, brand: "Topps", cardNumber: "414", sport: "hockey" })).toBeNull();
  });

  it("returns null when the match is ambiguous and uses the set name to settle it", () => {
    // Shaq has two 1992 Fleer brand rookies: Fleer and Fleer Ultra.
    expect(findKeyCard({ year: 1992, brand: "Fleer", player: "Shaquille O'Neal" })).toBeNull();
    expect(findKeyCard({ year: 1992, brand: "Fleer", setName: "Fleer Ultra", player: "Shaquille O'Neal" })?.cardNumber).toBe("328");
    // Mattingly has a regular Topps and no Traded card, but Ripken has both in 1982.
    expect(findKeyCard({ year: 1982, brand: "Topps", player: "Cal Ripken Jr." })).toBeNull();
    expect(findKeyCard({ year: 1982, brand: "Topps", setName: "Topps Traded", player: "Cal Ripken Jr." })?.cardNumber).toBe("98T");
  });

  it("separates sports that share a brand and number", () => {
    expect(findKeyCard({ year: 1985, brand: "O-Pee-Chee", cardNumber: "9" })?.player).toBe("Mario Lemieux");
    expect(findKeyCard({ year: 1980, brand: "Topps", cardNumber: "482", sport: "baseball" })?.player).toBe("Rickey Henderson");
  });
});

describe("keyCardsFor", () => {
  it("filters by year range, brand and sport", () => {
    const list = keyCardsFor({ year: 1987, yearEnd: 1991, brand: "Donruss" });
    expect(list.length).toBeGreaterThan(3);
    for (const k of list) {
      expect(k.brand).toBe("Donruss");
      expect(k.year).toBeGreaterThanOrEqual(1987);
      expect(k.year).toBeLessThanOrEqual(1991);
    }
    const hoops = keyCardsFor({ year: 1986, sport: "basketball" });
    expect(hoops.every((k) => k.sport === "basketball" && k.year === 1986)).toBe(true);
    expect(keyCardsFor({ year: 1990, brand: "Topps", sport: "hockey" })).toEqual([]);
  });

  it("sorts grail first, then key, then star, then year and card number", () => {
    const list = keyCardsFor({ year: 1980, yearEnd: 1995 });
    expect(list.length).toBe(KEY_CARDS.length);
    const rank = { grail: 0, key: 1, star: 2 } as const;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      expect(rank[a.tier]).toBeLessThanOrEqual(rank[b.tier]);
      if (a.tier === b.tier) expect(a.year).toBeLessThanOrEqual(b.year);
    }
    const fleer86 = keyCardsFor({ year: 1986, brand: "Fleer", sport: "basketball" }).filter((k) => k.tier === "key");
    const nums = fleer86.map((k) => Number(k.cardNumber));
    expect(nums).toEqual([...nums].sort((x, y) => x - y));
    expect(keyCardsFor({ year: 1986, brand: "Fleer", sport: "basketball" })[0].player).toBe("Michael Jordan");
  });

  it("uses a single year when no end year is given", () => {
    expect(keyCardsFor({ year: 1989 }).every((k) => k.year === 1989)).toBe(true);
  });
});
