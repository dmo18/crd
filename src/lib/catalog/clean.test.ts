import { describe, expect, it } from "vitest";
import { cleanCardNumber, cleanName, cleanSetName, cleanSport, cleanYear, setIdFromUrl, sourceUrl, splitProduct } from "./clean";

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
    // Sr. is part of the name, never a tag (review fix 1).
    ["KEN GRIFFEY SR", "Ken Griffey Sr.", []],
    ["CAL RIPKEN SR", "Cal Ripken Sr.", []],
    ["TIM RAINES SR AS", "Tim Raines Sr.", ["AS"]],
    ["Ken Griffey Sr.", "Ken Griffey Sr.", []],
    ["FRED MCGRIFF AS", "Fred McGriff", ["AS"]],
    ["Cal Ripken AS", "Cal Ripken", ["AS"]],
    // ROY can be a family name: a tag only right after Jr., Sr. or III.
    ["PATRICK ROY", "Patrick Roy", []],
    ["JEAN GUY ROY", "Jean Guy Roy", []],
    ["SANDY ALOMAR JR ROY", "Sandy Alomar Jr.", ["ROY"]],
    // Name case after ".", "(", "'" and "’" (review fix 4).
    ["D.J. DOZIER", "D.J. Dozier", []],
    ["J.T. SNOW", "J.T. Snow", []],
    ["MIKE (TEXAS) SMITH", "Mike (Texas) Smith", []],
    ["DAVE JOHNSON (P)", "Dave Johnson (P)", []],
    ["PAUL O’NEILL", "Paul O’Neill", []],
    ["PAUL O'NEILL", "Paul O'Neill", []],
    ["NOLAN RYAN SALUTE-NEW YORK METS", "Nolan Ryan Salute-New York Mets", []],
    ["RANDY MCCAMENT", "Randy McCament", []],
    ["DAVE MACDONALD", "Dave MacDonald", []],
    ["CHRIS VAN HORN", "Chris Van Horn", []],
    ["JOSÉ OFFERMAN", "José Offerman", []],
    ["CAL RIPKEN III", "Cal Ripken III", []],
    ["Paul O’Neill", "Paul O’Neill", []],
    // Tags seen in the 1990 Topps checklist (#6, #314, #444, #396) (review fix 5).
    ["VINCE COLEMAN RB", "Vince Coleman", ["RB"]],
    ["DONALD HARRIS FDP", "Donald Harris", ["FDP"]],
    ["KYLE ABBOTT FDP", "Kyle Abbott", ["FDP"]],
    ["BART GIAMATTI MEM", "Bart Giamatti", ["MEM"]],
    ["TOM LASORDA MGR", "Tom Lasorda", ["MGR"]],
  ])("%s", (raw, name, tags) => {
    expect(cleanName(raw)).toEqual({ name, tags });
  });
  it("cuts a very long name to 200 characters, quickly", () => {
    const started = Date.now();
    const r = cleanName("A " + "RC ".repeat(300_000));
    expect(Date.now() - started).toBeLessThan(1000);
    expect((r.name ?? "").length).toBeLessThanOrEqual(200);
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
    // "NO" without a dot is part of the number; hyphens keep printed order (review fix 7).
    ["NOV1", "NOV1"], ["no.v1", "V1"], ["U90-36", "U90-36"], ["u90 - 36", "U90-36"], ["90AS-28", "90AS-28"],
    ["#90as-28", "90AS-28"], ["--", null], ["A-B", null], ["1-2-3-4", null],
  ])("%s", (raw, out) => {
    expect(cleanCardNumber(raw as string | null)).toBe(out);
  });
});

describe("cleanCardNumber with hyphens: what is kept and what is refused", () => {
  it("documents OR-1 and 1986-87, and refuses broken hyphen shapes", () => {
    // "or" alone is a misread word, but "OR-1" has the printed shape of a hyphen number: kept as read.
    expect(cleanCardNumber("or")).toBeNull();
    expect(cleanCardNumber("OR-1")).toBe("OR-1");
    expect(cleanCardNumber("or - 1")).toBe("OR-1");
    // A season read into the number field is kept as a hyphen number, never turned into a year here
    // (the year field takes "1986" from it); it agrees with no card number, so it never makes a card sure.
    expect(cleanCardNumber("1986-87")).toBe("1986-87");
    expect(cleanYear("1986-87")).toBe(1986);
    // Negative: a hyphen at an end, more than three parts, a part over 6 characters, or no digit.
    for (const bad of ["-1", "1-", "OR-", "-", "1-2-3-4", "1234567-1", "OR-AB", "A--1", "1_2", "1/2"]) {
      expect(cleanCardNumber(bad), bad).toBeNull();
    }
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
  it("cuts brand, variation and set to 200 characters, quickly", () => {
    const long = "x".repeat(5000);
    const started = Date.now();
    expect(splitProduct(long).brand?.length).toBe(200);
    expect(splitProduct("Topps " + "word ".repeat(100_000)).variation?.length).toBeLessThanOrEqual(200);
    expect(cleanSetName(long)?.length).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(splitProduct("O Pee Chee Premier")).toEqual({ brand: "O-Pee-Chee", variation: "Premier" });
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
  it("rebuilds the card page as https://mycardfolio.com + path (review fix 8)", () => {
    expect(sourceUrl(ok)).toBe(ok);
    expect(sourceUrl("https://user:pw@mycardfolio.com/sports/x?q=1#top")).toBe("https://mycardfolio.com/sports/x");
    expect(sourceUrl("https://MyCardfolio.com/a")).toBe("https://mycardfolio.com/a");
    expect(sourceUrl("https://mycardfolio.com:8443/a")).toBeNull();
    expect(sourceUrl("http://mycardfolio.com/a")).toBeNull();
    expect(sourceUrl("https://evil.example/a")).toBeNull();
    expect(sourceUrl("not a url")).toBeNull();
  });
  it("gives nothing for noise and junk", () => {
    expect(setIdFromUrl("https://mycardfolio.com/sports/baseball/1990/topps-ebay_15c7ea716b/ken-griffey-jr-#336-hof-ebay_3bd0d0a0bd/336-x-ebay_28f4226b2d01")).toBeNull();
    expect(setIdFromUrl("not a url")).toBeNull();
    expect(setIdFromUrl(null)).toBeNull();
  });
});
