import { describe, expect, it } from "vitest";
import { buildSearchQuery, soldListingLinks } from "./links";

const blank = {
  kind: "card" as const, year: null, brand: null, setName: null, player: null, cardNumber: null, variation: null,
  grader: null, grade: null, certNumber: null, sport: null, productType: null,
};

describe("sold listing links", () => {
  it("builds a card search and skips a set that repeats the brand", () => {
    const item = { ...blank, year: 1989, brand: "Upper Deck", setName: "Upper Deck", player: "Ken Griffey Jr.", cardNumber: "1" };
    expect(buildSearchQuery(item)).toBe("1989 Upper Deck Ken Griffey Jr. #1");
    const links = soldListingLinks(item);
    expect(links.map((l) => l.label)).toEqual(["eBay sold listings", "130point sold search"]);
    const ebay = new URL(links[0].href);
    expect(ebay.hostname).toBe("www.ebay.com");
    expect(ebay.searchParams.get("_nkw")).toBe("1989 Upper Deck Ken Griffey Jr. #1");
    expect(ebay.searchParams.get("LH_Sold")).toBe("1");
  });

  it("adds the grade and a PSA lookup only for a clean cert number", () => {
    const graded = { ...blank, year: 1986, brand: "Fleer", player: "Michael Jordan", cardNumber: "57", grader: "psa", grade: "8", certNumber: "12345678" };
    expect(buildSearchQuery(graded)).toContain("psa 8");
    expect(soldListingLinks(graded).at(-1)).toEqual({ label: "PSA cert lookup", href: "https://www.psacard.com/cert/12345678" });
    expect(soldListingLinks({ ...graded, certNumber: "12/../x" })).toHaveLength(2);
    expect(soldListingLinks({ ...graded, grader: "BGS" })).toHaveLength(2);
  });

  it("encodes awkward characters instead of letting them change the address", () => {
    const item = { ...blank, year: 1990, brand: "Topps & Co", player: 'José "Joe" O\'Neil?x=1&y=2', cardNumber: "A#1" };
    for (const link of soldListingLinks(item)) {
      const url = new URL(link.href);
      expect(["www.ebay.com", "130point.com"]).toContain(url.hostname);
      expect(url.searchParams.has("y")).toBe(false);
      expect(url.searchParams.get(url.hostname === "www.ebay.com" ? "_nkw" : "search")).toContain("José");
      expect(link.href).not.toContain('"');
    }
  });

  it("searches sealed product as sealed, and gives nothing for bulk or blank items", () => {
    const sealed = { ...blank, kind: "sealed" as const, year: 1990, brand: "Topps", sport: "baseball" as const, productType: "box" as const };
    expect(buildSearchQuery(sealed)).toBe("1990 Topps baseball wax box sealed");
    expect(soldListingLinks({ ...blank, kind: "bulk" as const, year: 1988, brand: "Donruss" })).toEqual([]);
    expect(soldListingLinks(blank)).toEqual([]);
    expect(buildSearchQuery({ ...blank, player: "x".repeat(300) }).length).toBeLessThanOrEqual(120);
  });
});
