import { describe, expect, it } from "vitest";
import { parseBenchArgs, showsCards, wanted } from "./args";

describe("parseBenchArgs", () => {
  it("has no filters by default", () => {
    expect(parseBenchArgs([])).toEqual({ cards: [], showText: false });
  });
  it("reads --out, --split, --card and --show-text", () => {
    expect(parseBenchArgs(["--split", "tune", "--card", "a1", "--card", "b2", "--show-text", "--out", "r.json"]))
      .toEqual({ split: "tune", cards: ["a1", "b2"], showText: true, out: "r.json" });
  });
  it("refuses a flag without its value", () => {
    expect(() => parseBenchArgs(["--split"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["--card", "--show-text"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["--out"])).toThrow(/needs a value/);
  });
  it("refuses unknown options and odd split names", () => {
    expect(() => parseBenchArgs(["--fast"])).toThrow(/unknown option/);
    expect(() => parseBenchArgs(["--split", "a b"])).toThrow(/unknown name/);
  });
});

describe("wanted", () => {
  it("filters by split and card", () => {
    const args = parseBenchArgs(["--split", "tune"]);
    expect(wanted(args, { id: "x", split: "tune" })).toBe(true);
    expect(wanted(args, { id: "x", split: "holdout" })).toBe(false);
    const one = parseBenchArgs(["--card", "x"]);
    expect(wanted(one, { id: "x", split: "holdout" })).toBe(true);
    expect(wanted(one, { id: "y", split: "tune" })).toBe(false);
  });
});

describe("showsCards", () => {
  it("never shows held back cards one by one", () => {
    expect(showsCards("holdout")).toBe(false);
    expect(showsCards("tune")).toBe(true);
    expect(showsCards("all")).toBe(true);
  });
});
