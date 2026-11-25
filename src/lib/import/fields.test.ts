import { describe, expect, it } from "vitest";
import { itemsToCsv } from "@/lib/export/csv";
import { cleanYear, matchCondition, matchSport, yesNo, cleanMoney } from "./clean";
import { parseCsv } from "./csv";
import { guessMapping, guessOne, headerKey, SKIP } from "./fields";

describe("guessing columns from header words", () => {
  it("knows the common words", () => {
    const cases: [string, string][] = [
      ["Player", "player"], ["Name", "player"], ["Year", "year"], ["Brand", "brand"], ["Manufacturer", "brand"],
      ["Set", "setName"], ["Card #", "cardNumber"], ["Number", "cardNumber"], ["No.", "cardNumber"], ["Team", "team"],
      ["Sport", "sport"], ["Qty", "quantity"], ["Quantity", "quantity"], ["Condition", "condition"], ["Grade", "grade"],
      ["Grader", "grader"], ["Cert", "certNumber"], ["Serial", "serialNumber"], ["Rookie", "isRookie"], ["RC", "isRookie"],
      ["Auto", "isAutograph"], ["Value", "manualValue"], ["Price", "manualValue"], ["Location", "location"],
      ["Box", "location"], ["Notes", "notes"], ["  PLAYER  ", "player"], ["Card Year:", "year"],
    ];
    for (const [h, f] of cases) expect([h, guessOne(h)]).toEqual([h, f]);
    expect(guessOne("Something else")).toBeNull();
    expect(headerKey(" Card  No. ")).toBe("card no");
  });

  it("maps the app's own export headers exactly, and leaves out the columns the app works out", () => {
    const header = parseCsv(itemsToCsv([], new Map()) + "1\n");
    if (!header.ok) throw new Error(header.error);
    const m = guessMapping(header.header);
    const by = Object.fromEntries(header.header.map((h, i) => [h, m[i]]));
    expect(by).toMatchObject({
      ID: "id", Kind: "kind", Status: SKIP, Title: SKIP, Sport: "sport", Year: "year", "Year end": "yearEnd", Brand: "brand",
      Set: "setName", "Card number": "cardNumber", Player: "player", Team: "team", Variation: "variation", Rookie: "isRookie",
      "Serial number": "serialNumber", Condition: "condition", Grader: "grader", Grade: "grade", "Cert number": "certNumber",
      Quantity: "quantity", Location: "location", "Value each (USD)": SKIP, "Total value (USD)": SKIP,
      "Your value (USD)": "manualValue", Notes: "notes", "Added (ISO date)": SKIP, Description: "description",
    });
  });

  it("uses each field once, and Paid only when there is no value column", () => {
    expect(guessMapping(["Player", "Name", "Year"])).toEqual(["player", SKIP, "year"]);
    expect(guessMapping(["Player", "Paid"])).toEqual(["player", "manualValue"]);
    expect(guessMapping(["Player", "Paid", "Value"])).toEqual(["player", SKIP, "manualValue"]);
  });
});

describe("cleaning values", () => {
  it("reads yes and no words", () => {
    for (const s of ["Yes", "y", "TRUE", "x", "1"]) expect(yesNo(s)).toBe(true);
    for (const s of ["No", "n", "false", "0"]) expect(yesNo(s)).toBe(false);
    expect(yesNo(" ")).toBeNull();
    expect(yesNo("maybe")).toBe("bad");
  });

  it("reads years and seasons", () => {
    expect(cleanYear("1989")).toBe(1989);
    expect(cleanYear("1993-94")).toBe(1993);
    expect(cleanYear("1993/94")).toBe(1993);
    expect(cleanYear("1993 - 1994")).toBe(1993);
    expect(cleanYear("89")).toBeNull();
    expect(cleanYear("1989.5")).toBeNull();
  });

  it("reads dollars into cents", () => {
    expect(cleanMoney("$1,234.50")).toBe(123450);
    expect(cleanMoney("12")).toBe(1200);
    expect(cleanMoney("-5")).toBeNull();
    expect(cleanMoney("about 5")).toBeNull();
  });

  it("matches sport and condition words with any capitals", () => {
    expect(matchSport("BASEBALL")).toBe("baseball");
    expect(matchSport("cricket")).toBeNull();
    expect(matchCondition("Near Mint")).toBe("near_mint");
    expect(matchCondition("near_mint")).toBe("near_mint");
    expect(matchCondition("nm")).toBe("near_mint");
    expect(matchCondition("very-good")).toBe("very_good");
    expect(matchCondition("shiny")).toBeNull();
  });
});
