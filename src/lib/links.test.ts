import { describe, expect, it } from "vitest";
import { buildSearchQuery, EBAY_CATEGORY, linkLabel, POPULATION_NOTE, priceLinks } from "./links";

const blank = {
  kind: "card" as const, year: null, brand: null, setName: null, player: null, cardNumber: null, variation: null,
  grader: null, grade: null, certNumber: null, sport: null, productType: null,
};
const DASHES = new RegExp("[\\u2013\\u2014]");

describe("price links", () => {
  it("builds a card search and skips a set that repeats the brand", () => {
    const item = { ...blank, year: 1989, brand: "Upper Deck", setName: "Upper Deck", player: "Ken Griffey Jr.", cardNumber: "1" };
    expect(buildSearchQuery(item)).toBe("1989 Upper Deck Ken Griffey Jr. #1");
    const { sales } = priceLinks(item);
    expect(sales.map((l) => l.label)).toEqual([
      "eBay sold listings", "eBay for sale now", "130point", "TCDB card search", "COMC search", "SportsCardsPro prices", "Google search",
    ]);
    const ebay = new URL(sales[0].href);
    expect(ebay.hostname).toBe("www.ebay.com");
    expect(ebay.pathname).toBe("/sch/i.html");
    expect(ebay.searchParams.get("_nkw")).toBe("1989 Upper Deck Ken Griffey Jr. #1");
    expect(ebay.searchParams.get("_sacat")).toBe(EBAY_CATEGORY);
    expect(ebay.searchParams.get("LH_Sold")).toBe("1");
    expect(ebay.searchParams.get("LH_Complete")).toBe("1");
    expect(new URL(sales[1].href).searchParams.has("LH_Sold")).toBe(false);
    expect(sales[2]).toEqual({ label: "130point", href: "https://130point.com/sales/", paste: "words" });
    // The site takes no words in its address: the button says to paste the card name (review 7).
    expect(linkLabel(sales[2]!)).toBe("130point (paste the card name)");
    expect(linkLabel(sales[0]!)).toBe("eBay sold listings");
    expect(new URL(sales[3].href).searchParams.get("q")).toBe("1989 Upper Deck Ken Griffey Jr. #1");
    const scp = new URL(sales[5].href);
    expect(scp.hostname).toBe("www.sportscardspro.com");
    expect(scp.searchParams.get("type")).toBe("prices");
    expect(new URL(sales[6].href).searchParams.get("q")).toBe("1989 Upper Deck Ken Griffey Jr. #1 sold");
    for (const l of sales) expect(DASHES.test(l.label)).toBe(false);
  });

  it("adds rookie, print run, autograph and grade words", () => {
    const item = {
      ...blank, year: 2020, brand: "Topps", setName: "Chrome", player: "Joe Modern", cardNumber: "#12",
      isRookie: true, isAutograph: true, serialNumber: "045/099", grader: "PSA", grade: "9",
    };
    expect(buildSearchQuery(item)).toBe("2020 Topps Chrome Joe Modern #12 RC /99 auto PSA 9");
    expect(buildSearchQuery({ ...item, serialNumber: null, serialEdition: "25" })).toContain("/25");
  });

  it("strips accents and encodes awkward characters instead of letting them change the address", () => {
    const item = { ...blank, year: 1990, brand: "Topps & Co", player: 'José "Joe" O\'Neil?x=1&y=2', cardNumber: "A#1" };
    expect(buildSearchQuery(item)).toBe("1990 Topps & Co Jose Joe O'Neil?x=1&y=2 #A#1");
    for (const link of priceLinks(item).sales) {
      const url = new URL(link.href);
      expect(url.searchParams.has("y")).toBe(false);
      expect(url.searchParams.has("x")).toBe(false);
      expect(link.href).not.toContain('"');
      expect(link.href).not.toContain(" ");
      expect(link.href.startsWith("https://")).toBe(true);
    }
    const comc = priceLinks(item).sales.find((l) => l.label === "COMC search")!;
    expect(decodeURIComponent(comc.href.split("Cards,=")[1])).toBe(buildSearchQuery(item));
    expect(new URL(comc.href).hostname).toBe("www.comc.com");
    expect(buildSearchQuery({ ...blank, player: "Zdeno Chára\u0000\n" })).toBe("Zdeno Chara");
  });

  it("gives certificate and population links for graded cards, only with a clean number", () => {
    const graded = { ...blank, year: 1986, brand: "Fleer", player: "Michael Jordan", cardNumber: "57", grader: "psa", grade: "8", certNumber: "12345678" };
    expect(buildSearchQuery(graded)).toContain("psa 8");
    const links = priceLinks(graded);
    expect(links.cert).toEqual([{ label: "PSA certificate", href: "https://www.psacard.com/cert/12345678" }]);
    expect(links.population.map((l) => l.label)).toEqual(["PSA population report"]);
    expect(priceLinks({ ...graded, certNumber: "12/../x" }).cert).toEqual([]);
    expect(priceLinks({ ...graded, grader: "CGC" }).cert[0].href).toBe("https://www.cgccards.com/certlookup/12345678/");
    expect(priceLinks({ ...graded, grader: "SGC" }).cert[0].paste).toBe("cert");
    expect(priceLinks({ ...graded, grader: "Beckett" }).population[0].label).toBe("Beckett population report");
    expect(priceLinks({ ...graded, grader: "Other Co" }).population).toHaveLength(4);
    expect(priceLinks({ ...graded, grader: null }).population).toEqual([]);
    expect(POPULATION_NOTE).toBe("This counts graded copies, not how many were printed");
  });

  it("searches sealed product as sealed, and gives nothing for bulk or blank items", () => {
    const sealed = { ...blank, kind: "sealed" as const, year: 1990, brand: "Topps", sport: "baseball" as const, productType: "box" as const };
    expect(buildSearchQuery(sealed)).toBe("1990 Topps baseball wax box sealed");
    expect(priceLinks(sealed).sales.map((l) => l.label)).toEqual(["eBay sold listings", "eBay for sale now", "130point", "Google search"]);
    expect(priceLinks({ ...blank, kind: "bulk" as const, year: 1988, brand: "Donruss" }).sales).toEqual([]);
    expect(priceLinks(blank)).toEqual({ query: "", sales: [], cert: [], population: [] });
    expect(buildSearchQuery({ ...blank, player: "x".repeat(300) }).length).toBeLessThanOrEqual(120);
  });
});
