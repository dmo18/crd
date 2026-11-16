import { describe, expect, it } from "vitest";
import { cleanCardNumber, cleanName, cleanSetName, cleanSport, cleanYear, setIdFromUrl, splitProduct } from "./clean";

describe("cleanName", () => {
  it.each([
    ["DAN MARINO IR", "Dan Marino", ["IR"]],
    ["FRANK THOMAS NO NAME ON FRONT", "Frank Thomas", ["NO NAME ON FRONT"]],
    ["Emmitt Smith RC", "Emmitt Smith", ["RC"]],
    ["Ken Griffey Jr", "Ken Griffey Jr.", []],
    ["Ken Griffey Jr.", "Ken Griffey Jr.", []],
    ["KEN GRIFFEY JR", "Ken Griffey Jr.", []],
    ["DALE MURPHY TC", "Dale Murphy", ["TC"]],
    ["BILL RIPKEN BLACKBOX", "Bill Ripken", ["BLACKBOX"]],
    ["MARK MCGWIRE", "Mark McGwire", []],
    ["SHAQUILLE O'NEAL", "Shaquille O'Neal", []],
    ["JOHN ST. CLAIR", "John St. Clair", []],
    ["OSCAR DE LA HOYA", "Oscar De La Hoya", []],
    ["Cal Ripken Jr. RC IR", "Cal Ripken Jr.", ["RC", "IR"]],
    ["MICHAEL JORDAN", "Michael Jordan", []],
  ])("%s", (raw, name, tags) => {
    expect(cleanName(raw)).toEqual({ name, tags });
  });
  it("keeps a lone word and empty input safe", () => {
    expect(cleanName("RC")).toEqual({ name: "Rc", tags: [] });
    expect(cleanName("")).toEqual({ name: null, tags: [] });
    expect(cleanName(null)).toEqual({ name: null, tags: [] });
  });
});

describe("cleanCardNumber", () => {
  it.each([
    ["11T", "11T"], ["0336", "336"], ["#27t", "27T"], ["No. 12", "12"], ["616a", "616A"], ["BC12", "BC12"],
    ["or", null], ["6m7", null], ["0p6", null], ["", null], [null, null], ["12345", null], ["0", "0"],
  ])("%s", (raw, out) => {
    expect(cleanCardNumber(raw as string | null)).toBe(out);
  });
});

describe("other cleaning", () => {
  it("year", () => {
    expect(cleanYear("1986-87")).toBe(1986);
    expect(cleanYear("1990")).toBe(1990);
    expect(cleanYear("n/a")).toBeNull();
  });
  it("sport", () => {
    expect(cleanSport("Baseball")).toBe("baseball");
    expect(cleanSport("Curling")).toBeNull();
  });
  it("product and set", () => {
    expect(splitProduct("Topps Tiffany")).toEqual({ brand: "Topps", variation: "Tiffany" });
    expect(splitProduct("O-PEE-CHEE")).toEqual({ brand: "O-Pee-Chee", variation: null });
    expect(splitProduct("Upper Deck")).toEqual({ brand: "Upper Deck", variation: null });
    expect(splitProduct("Sports Stars USA")).toEqual({ brand: "Sports Stars USA", variation: null });
    expect(splitProduct("")).toEqual({ brand: null, variation: null });
    expect(cleanSetName("Base Set")).toBeNull();
    expect(cleanSetName("Update")).toBe("Update");
  });
});

describe("setIdFromUrl", () => {
  const ok = "https://mycardfolio.com/sports/baseball/1990/topps-2129/base-set-9179/336-ken-griffey-jr-551033";
  it("takes the set id", () => expect(setIdFromUrl(ok)).toBe("9179"));
  it("refuses another host", () => {
    expect(setIdFromUrl(ok.replace("mycardfolio.com", "evil.example"))).toBeNull();
    expect(setIdFromUrl(ok.replace("https://mycardfolio.com", "https://mycardfolio.com.evil.example"))).toBeNull();
    expect(setIdFromUrl(ok.replace("https:", "http:"))).toBeNull();
  });
  it("gives nothing for noise and junk", () => {
    expect(setIdFromUrl("https://mycardfolio.com/sports/baseball/1990/topps-ebay_15c7ea716b/ken-griffey-jr-#336-hof-ebay_3bd0d0a0bd/336-x-ebay_28f4226b2d01")).toBeNull();
    expect(setIdFromUrl("not a url")).toBeNull();
    expect(setIdFromUrl(null)).toBeNull();
  });
});
