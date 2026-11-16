import { describe, expect, it } from "vitest";
import { canonicalKey, type KeyParts } from "./key";

const griffey: KeyParts = { sport: "baseball", year: 1990, brand: "Topps", setName: null, cardNumber: "336", player: "Ken Griffey Jr." };

describe("canonicalKey", () => {
  it("has the settled layout", () => {
    expect(canonicalKey(griffey)).toBe("v1|baseball|1990|topps|base|336|ken griffey jr");
  });

  it("gives one key for the same card from two spellings", () => {
    const other = canonicalKey({ sport: "Baseball", year: 1990, brand: " TOPPS ", setName: "Base Set", cardNumber: "#0336", player: "KEN  GRIFFEY, JR" });
    expect(other).toBe(canonicalKey(griffey));
    expect(canonicalKey({ ...griffey, brand: "O-Pee-Chee" })).toBe(canonicalKey({ ...griffey, brand: "o pee chee" }));
    expect(canonicalKey({ ...griffey, player: "Jaromír Jágr" })).toBe(canonicalKey({ ...griffey, player: "jaromir jagr" }));
    expect(canonicalKey({ ...griffey, setName: "" })).toBe(canonicalKey({ ...griffey, setName: "base set" }));
  });

  it("keeps \"11T\" and \"11\" apart", () => {
    const a = canonicalKey({ ...griffey, cardNumber: "11T" });
    const b = canonicalKey({ ...griffey, cardNumber: "11" });
    expect(a).not.toBe(b);
    expect(a).toContain("|T11|");
    expect(b).toContain("|11|");
  });

  it("keeps Tiffany apart from the base card", () => {
    const tiffany = canonicalKey({ ...griffey, variation: "Tiffany" });
    expect(tiffany).toBe("v1|baseball|1990|topps|base|336|ken griffey jr|tiffany");
    expect(tiffany).not.toBe(canonicalKey(griffey));
    // An empty variation adds no part.
    expect(canonicalKey({ ...griffey, variation: "  " })).toBe(canonicalKey(griffey));
  });

  it("keeps different sets, years, sports and players apart", () => {
    const base = canonicalKey(griffey);
    expect(canonicalKey({ ...griffey, setName: "Traded" })).not.toBe(base);
    expect(canonicalKey({ ...griffey, year: 1989 })).not.toBe(base);
    expect(canonicalKey({ ...griffey, sport: "football" })).not.toBe(base);
    expect(canonicalKey({ ...griffey, player: "Ken Griffey Sr." })).not.toBe(base);
  });

  it("allows an empty number", () => {
    expect(canonicalKey({ ...griffey, cardNumber: null })).toBe("v1|baseball|1990|topps|base||ken griffey jr");
  });

  it("gives null when sport, year, brand or player is missing", () => {
    expect(canonicalKey({ ...griffey, sport: null })).toBeNull();
    expect(canonicalKey({ ...griffey, sport: "curling" })).toBeNull();
    expect(canonicalKey({ ...griffey, year: null })).toBeNull();
    expect(canonicalKey({ ...griffey, year: 19.5 })).toBeNull();
    expect(canonicalKey({ ...griffey, brand: " - " })).toBeNull();
    expect(canonicalKey({ ...griffey, player: "" })).toBeNull();
  });

  it("never lets a value add a key part", () => {
    expect(canonicalKey({ ...griffey, player: "Ken|Griffey", setName: "a|b" })!.split("|")).toHaveLength(7);
  });
});
