import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, type NewItem } from "@/db/schema";
import { decadeBreakdown, highlights, kindBreakdown, recentItems, topItems } from "./stats";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
});
function add(over: Partial<NewItem> & { title: string }): number {
  return db.insert(items).values({ kind: "card", ...over }).returning({ id: items.id }).get().id;
}

describe("kindBreakdown", () => {
  it("is all zeros when empty", () => {
    expect(kindBreakdown(db)).toEqual([
      { kind: "card", rows: 0, units: 0, valueCents: 0 },
      { kind: "sealed", rows: 0, units: 0, valueCents: 0 },
      { kind: "bulk", rows: 0, units: 0, valueCents: 0 },
    ]);
  });
  it("multiplies by quantity and lets the manual value win", () => {
    add({ title: "a", estValueCents: 1000, quantity: 3 });
    add({ title: "b", estValueCents: 5000, manualValueCents: 200, quantity: 2 });
    add({ title: "c" });
    add({ title: "s", kind: "sealed", estValueCents: 700 });
    const k = kindBreakdown(db);
    expect(k[0]).toEqual({ kind: "card", rows: 3, units: 6, valueCents: 3400 });
    expect(k[1]).toEqual({ kind: "sealed", rows: 1, units: 1, valueCents: 700 });
    expect(k[2].rows).toBe(0);
  });
});

describe("topItems", () => {
  it("orders by per-unit value, ties by id desc, and skips unvalued", () => {
    const a = add({ title: "a", estValueCents: 500 });
    add({ title: "none" });
    const b = add({ title: "b", estValueCents: 500 });
    const c = add({ title: "c", estValueCents: 9000, manualValueCents: 800, quantity: 10 });
    const d = add({ title: "d", estValueCents: 100, quantity: 99 });
    expect(topItems(10, db).map((r) => r.id)).toEqual([c, b, a, d]);
    expect(topItems(2, db)).toHaveLength(2);
  });
});

describe("highlights", () => {
  it("counts each signal", () => {
    add({ title: "1", isRookie: true, rarityTier: "key", estValueCents: 1, valueSource: "sample", worthGrading: true });
    add({ title: "2", rarityTier: "grail", status: "confirmed", manualValueCents: 5, valueSource: "sample" });
    add({ title: "3", rarityTier: "star", status: "confirmed" });
    expect(highlights(db)).toEqual({
      rookies: 1, keyCards: 2, worthGrading: 1, needsReview: 1, noValue: 1, sampleValued: 1,
    });
  });
  it("is zero when empty", () => {
    expect(Object.values(highlights(db)).every((v) => v === 0)).toBe(true);
  });
});

describe("decadeBreakdown", () => {
  it("groups by decade with unknown last", () => {
    add({ title: "a", year: 1991, estValueCents: 100, quantity: 2 });
    add({ title: "b", year: 1985, estValueCents: 300 });
    add({ title: "c", year: 1989, manualValueCents: 50 });
    add({ title: "d", estValueCents: 10 });
    add({ title: "e", year: 2001, estValueCents: 1 });
    expect(decadeBreakdown(db)).toEqual([
      { label: "1980s", units: 2, valueCents: 350 },
      { label: "1990s", units: 2, valueCents: 200 },
      { label: "2000s", units: 1, valueCents: 1 },
      { label: "Unknown", units: 1, valueCents: 10 },
    ]);
  });
});

describe("recentItems", () => {
  it("returns newest first within the limit", () => {
    add({ title: "a" });
    add({ title: "b" });
    const c = add({ title: "c" });
    const r = recentItems(2, db);
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe(c);
  });
});
