import { describe, expect, it } from "vitest";
import type { Item } from "@/db/schema";
import { itemsToCsv } from "./csv";

const row = (over: Partial<Item> = {}): Item => ({
  id: 1, kind: "card", status: "confirmed", scanId: null, title: "T", sport: null, year: null, yearEnd: null, brand: null,
  setName: null, cardNumber: null, player: null, team: null, variation: null, isRookie: false, isError: false,
  isParallel: false, isInsert: false, isAutograph: false, isMemorabilia: false, serialNumber: null, rarityTier: null,
  rarityNotes: null, condition: null, conditionNotes: null, grader: null, grade: null, certNumber: null,
  worthGrading: null, gradingNotes: null, productType: null, packCount: null, sealState: null, estCount: null,
  containerType: null, description: null, pullList: null, quantity: 1, soldPriceCents: null, soldAt: null, statusBefore: null, locationId: null, notes: null, confidence: null,
  aiNotes: null, estLowCents: null, estHighCents: null, estValueCents: null, valueSource: null, valueBasis: null,
  valuedAt: null, manualValueCents: null, createdAt: new Date("2026-03-04T10:00:00Z"), updatedAt: new Date(), deletedAt: null,
  catalogCardId: null, firstSuggestion: null, fieldSources: null, catalogCandidates: null,
  versionState: null, versionSource: null, versionOptions: null, serialCopy: null, serialEdition: null, serialSuggested: null,
  rookieState: null, rookieSource: null, rookieNote: null, keptApartFrom: null,
  ...over,
});

const parse = (csv: string) => {
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  lines.pop();
  return lines;
};
const none = new Map<number, string>();

describe("itemsToCsv", () => {
  it("leaves the catalog columns out", () => {
    const plain = itemsToCsv([row({ player: "Ken Griffey Jr." })], none);
    const linked = itemsToCsv([row({
      player: "Ken Griffey Jr.", catalogCardId: 77123, firstSuggestion: "{\"v\":1,\"secretmark\":1}",
      fieldSources: "{\"player\":\"reading\"}", catalogCandidates: "{\"candidatemark\":1}",
    })], none);
    expect(linked).toBe(plain);
    expect(parse(linked)[0]).not.toMatch(/catalog|suggestion|source[s ]|candidate/i);
  });

  it("empty collection gives only the header, with BOM and CRLF", () => {
    const csv = itemsToCsv([], none);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = parse(csv);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ID,Kind,Status,Title,/);
    // The sold columns come just before Description, which stays last.
    expect(lines[0]).toMatch(/,Notes,Added \(ISO date\),Sold price \(USD\),Sold date,Description$/);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("quotes commas, quotes and line breaks", () => {
    const csv = itemsToCsv([row({ title: 'A, "B"', notes: "line1\nline2" })], none);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it("guards each formula trigger character", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const csv = itemsToCsv([row({ player: `${lead}HYPERLINK("x")` })], none);
      expect(csv).toContain(`'${lead}HYPERLINK`);
    }
    expect(itemsToCsv([row({ player: '=HYPERLINK("http://x","y")' })], none)).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(itemsToCsv([row({ player: "Safe =1" })], none)).not.toContain("'Safe");
  });

  it("formats money as plain decimals and does not guard numbers", () => {
    const lines = parse(itemsToCsv([row({ quantity: 3, estValueCents: 1250, estLowCents: 1000, estHighCents: 1500, manualValueCents: 2000 })], new Map()));
    const header = lines[0].split(",");
    const cells = lines[1].split(",");
    const at = (h: string) => cells[header.indexOf(h)];
    expect(at("Value each (USD)")).toBe("20.00");
    expect(at("Total value (USD)")).toBe("60.00");
    expect(at("Estimate low (USD)")).toBe("10.00");
    expect(at("Estimate high (USD)")).toBe("15.00");
    expect(at("Your value (USD)")).toBe("20.00");
    expect(at("Value source")).toBe("Your value");
    expect(at("Added (ISO date)")).toBe("2026-03-04");
    expect(lines[1]).not.toContain("$");
  });

  it("writes the sold price and day of a sold item, and leaves them blank otherwise", () => {
    const lines = parse(itemsToCsv([row({ status: "sold", soldPriceCents: 4550, soldAt: new Date("2026-11-20T00:00:00Z") }), row()], none));
    const header = lines[0].split(",");
    const cell = (line: string, h: string) => line.split(",")[header.indexOf(h)];
    expect(cell(lines[1], "Status")).toBe("Sold");
    expect(cell(lines[1], "Sold price (USD)")).toBe("45.50");
    expect(cell(lines[1], "Sold date")).toBe("2026-11-20");
    expect(cell(lines[2], "Sold price (USD)")).toBe("");
    expect(cell(lines[2], "Sold date")).toBe("");
  });

  it("leaves Rookie blank when unknown and writes No only for an answer", () => {
    const rookie = (over: Partial<Item>) => {
      const lines = parse(itemsToCsv([row(over)], new Map()));
      return lines[1].split(",")[lines[0].split(",").indexOf("Rookie")];
    };
    expect(rookie({ isRookie: false, rookieState: null })).toBe("");
    expect(rookie({ isRookie: false, rookieState: "unknown" })).toBe("");
    expect(rookie({ isRookie: false, rookieState: "disputed" })).toBe("");
    expect(rookie({ isRookie: false, rookieState: "no", rookieSource: "owner" })).toBe("No");
    expect(rookie({ isRookie: true, rookieState: "yes", rookieSource: "owner" })).toBe("Yes");
    expect(rookie({ isRookie: true, rookieState: null })).toBe("Yes");
  });

  it("writes Yes/No flags and the location name", () => {
    const lines = parse(itemsToCsv([row({ isRookie: true, locationId: 5 })], new Map([[5, "Box 1"]])));
    const header = lines[0].split(",");
    const cells = lines[1].split(",");
    expect(cells[header.indexOf("Rookie")]).toBe("Yes");
    expect(cells[header.indexOf("Error")]).toBe("No");
    expect(cells[header.indexOf("Location")]).toBe("Box 1");
  });
});

describe("formula guard, leading whitespace", () => {
  it("guards formulas hidden behind spaces or a line break, and leaves normal text alone", async () => {
    const { guardFormula } = await import("./csv");
    expect(guardFormula(" =HYPERLINK(1)")).toBe("' =HYPERLINK(1)");
    expect(guardFormula("\n=1+1")).toBe("'\n=1+1");
    expect(guardFormula("Ken Griffey Jr.")).toBe("Ken Griffey Jr.");
    // Text already starting with an apostrophe before a trigger gets one more, so the import can take exactly one off.
    expect(guardFormula("'=1+1")).toBe("''=1+1");
    expect(guardFormula("'89 Topps")).toBe("'89 Topps");
    expect(guardFormula("Topps - Traded")).toBe("Topps - Traded");
  });
});

describe("itemsToCsv description column", () => {
  it("is the last column and is formula-guarded", () => {
    const csv = itemsToCsv([row({ description: '=SUM(1,2)' }), row({ description: "Plain, with comma" })], none);
    const lines = parse(csv);
    expect(lines[0].endsWith(",Description")).toBe(true);
    expect(lines[1].endsWith(`,"'=SUM(1,2)"`)).toBe(true);
    expect(lines[2].endsWith(`,"Plain, with comma"`)).toBe(true);
  });
});
