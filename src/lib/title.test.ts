import { describe, expect, it } from "vitest";
import { buildTitle } from "./title";

describe("buildTitle brand handling", () => {
  it("does not repeat the brand when the set name starts with it", () => {
    expect(buildTitle({ kind: "card", year: 1998, brand: "Upper Deck", setName: "Upper Deck Exclusives", cardNumber: "5", player: "Ken Griffey Jr." }))
      .toBe("1998 Upper Deck Exclusives #5 Ken Griffey Jr.");
    expect(buildTitle({ kind: "card", year: 1998, brand: "upper deck", setName: "Upper Deck Exclusives" })).toBe("1998 Upper Deck Exclusives");
  });
  it("keeps the brand when the set name only shares letters with it", () => {
    expect(buildTitle({ kind: "card", year: 1989, brand: "Topps", setName: "Toppsy Traded" })).toBe("1989 Topps Toppsy Traded");
    expect(buildTitle({ kind: "card", year: 1989, brand: "Topps", setName: "Traded" })).toBe("1989 Topps Traded");
  });
  it("still skips a set name that equals the brand", () => {
    expect(buildTitle({ kind: "card", year: 1989, brand: "Topps", setName: "Topps" })).toBe("1989 Topps");
  });
  it("works for sealed product too", () => {
    expect(buildTitle({ kind: "sealed", year: 1998, brand: "Upper Deck", setName: "Upper Deck Exclusives", productType: "box" })).toBe("1998 Upper Deck Exclusives box");
  });
});
