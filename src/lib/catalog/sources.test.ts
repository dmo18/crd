import { describe, expect, it } from "vitest";
import type { Item } from "@/db/schema";
import { buildFirstSuggestion, markOwnerChanges, parseFieldSources, parseFirstSuggestion, sourceOf, sourcesFor } from "./sources";

const item = (over: Partial<Item>) => ({
  sport: null, year: null, brand: null, setName: null, cardNumber: null, player: null, team: null, variation: null, fieldSources: null, ...over,
}) as Item;

describe("field sources", () => {
  it("marks only filled fields", () => {
    expect(JSON.parse(sourcesFor({ player: "Ken", year: 1990, team: "", brand: null, setName: "  " }, "reading"))).toEqual({ player: "reading", year: "reading" });
  });

  it("reads null, broken text and unknown values as no marks", () => {
    expect(parseFieldSources(null)).toBeNull();
    expect(parseFieldSources("not json")).toBeNull();
    expect(parseFieldSources("[1]")).toBeNull();
    expect(parseFieldSources("{\"notAField\":\"owner\"}")).toBeNull();
    expect(parseFieldSources("{\"player\":\"catalog\",\"team\":\"made_up\"}")).toEqual({ player: "catalog" });
  });

  it("treats a filled field without a mark as the owner's, and an empty field as nobody's", () => {
    expect(sourceOf(item({ player: "Ken" }), "player")).toBe("owner");
    expect(sourceOf(item({ player: "Ken", fieldSources: "{\"team\":\"reading\"}" }), "player")).toBe("owner");
    expect(sourceOf(item({ player: "Ken", fieldSources: "broken" }), "player")).toBe("owner");
    expect(sourceOf(item({ player: "Ken", fieldSources: "{\"player\":\"reading\"}" }), "player")).toBe("reading");
    expect(sourceOf(item({ fieldSources: "{\"player\":\"reading\"}" }), "player")).toBeNull();
  });

  it("marks what the owner changed as owner and drops the mark of an emptied field", () => {
    const row = item({ player: "Ken Grifey", team: "Twins", year: 1990, fieldSources: "{\"player\":\"reading\",\"team\":\"reading\",\"year\":\"reading\"}" });
    const next = markOwnerChanges(row, { player: "Ken Griffey Jr.", team: null, year: 1990, brand: "Topps" });
    expect(JSON.parse(next!)).toEqual({ player: "owner", year: "reading", brand: "owner" });
  });

  it("writes nothing when nothing changed, or when the item has no marks (already all owner)", () => {
    const row = item({ player: "Ken", fieldSources: "{\"player\":\"reading\"}" });
    expect(markOwnerChanges(row, { player: "Ken" })).toBeUndefined();
    expect(markOwnerChanges(row, {})).toBeUndefined();
    expect(markOwnerChanges(item({ player: "Ken" }), { player: "Kenny", team: "Mariners" })).toBeUndefined();
  });
});

describe("first suggestion", () => {
  it("keeps the fields read, the confidence, the reader and the time", () => {
    const at = new Date("2026-11-16T10:00:00Z");
    const raw = buildFirstSuggestion({ player: "Ken Grifey", year: 1990, team: null }, { confidence: 0.42, reader: "free", at });
    expect(parseFirstSuggestion(raw)).toEqual({ v: 1, fields: { player: "Ken Grifey", year: 1990 }, confidence: 0.42, reader: "free", at: at.getTime() });
  });

  it("gives null for old items and for text that cannot be read", () => {
    expect(parseFirstSuggestion(null)).toBeNull();
    expect(parseFirstSuggestion("{")).toBeNull();
    expect(parseFirstSuggestion("{\"v\":2}")).toBeNull();
  });
});
