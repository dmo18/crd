import { describe, expect, it } from "vitest";
import { KNOWN_VERSIONS, knownVersionsFor } from "./versions-known";

const names = (item: Parameters<typeof knownVersionsFor>[0]) => knownVersionsFor(item).map((r) => r.name);
const card = (brand: string | null, year: number | null, setName: string | null = null, sport: "baseball" | "football" | "hockey" | null = "baseball") =>
  ({ brand, year, setName, sport });

describe("known versions list", () => {
  it("every row has a source note, a way to tell, a sane year range and a unique id", () => {
    expect(KNOWN_VERSIONS.length).toBeGreaterThanOrEqual(10);
    expect(KNOWN_VERSIONS.length).toBeLessThanOrEqual(15);
    const ids = new Set<string>();
    for (const row of KNOWN_VERSIONS) {
      expect(row.source.length, row.id).toBeGreaterThan(20);
      expect(row.howToTell.length, row.id).toBeGreaterThan(10);
      expect(row.from).toBeLessThanOrEqual(row.to);
      expect(row.from).toBeGreaterThanOrEqual(1980);
      expect(`${row.name} ${row.howToTell} ${row.source}`).not.toMatch(/[\u2013\u2014]/);
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
  });

  it("offers a row when brand and year fit", () => {
    expect(names(card("Topps", 1990))).toEqual(["Tiffany", "O-Pee-Chee"]);
    expect(names(card("Topps", 1991))).toEqual(["Tiffany", "Desert Shield", "O-Pee-Chee"]);
    expect(names(card("Fleer", 1989))).toEqual(["Glossy"]);
    expect(names(card("Topps", 1993))).toEqual(["Gold"]);
    expect(names(card("Upper Deck", 1994))).toEqual(["Electric Diamond"]);
    expect(names(card("Score", 1994))).toEqual(["Gold Rush"]);
  });

  it("offers nothing outside the years, for another brand, or without year or brand", () => {
    expect(names(card("Topps", 1983))).toEqual(["O-Pee-Chee"]);
    expect(names(card("Fleer", 1990))).toEqual([]);
    expect(names(card("Donruss", 1990))).toEqual([]);
    expect(names(card(null, 1990))).toEqual([]);
    expect(names(card("Topps", null))).toEqual([]);
  });

  it("keeps rows for some sports to those sports, and offers them when the sport is not known", () => {
    expect(names(card("Topps", 1991, null, "football"))).toEqual([]);
    expect(names(card("Topps", 1993, null, "football"))).toEqual(["Gold"]);
    expect(names(card("Topps", 1990, null, "hockey"))).toEqual(["O-Pee-Chee"]);
    expect(names(card("Topps", 1991, null, null))).toEqual(["Tiffany", "Desert Shield", "O-Pee-Chee"]);
  });

  it("a set name that is a line of its own takes the place of the brand", () => {
    expect(names(card("Upper Deck", 1994, "Collector's Choice"))).toEqual(["Silver Signature", "Gold Signature"]);
    expect(names(card("Topps", 1993, "Stadium Club"))).toEqual(["First Day Issue"]);
    expect(names(card("Fleer", 1995, "Ultra"))).toEqual(["Gold Medallion"]);
    // A set name that is not a line leaves the brand's rows.
    expect(names(card("Topps", 1990, "Traded"))).toEqual(["Tiffany", "O-Pee-Chee"]);
  });
});
