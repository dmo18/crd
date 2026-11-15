import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, valuations, type NewItem } from "@/db/schema";
import { findDuplicates, MAX_QUANTITY, mergeInto, reviewCount } from "./duplicates";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const card: Partial<NewItem> = { year: 1989, brand: "Upper Deck", setName: "Base", cardNumber: "1", player: "Ken Griffey Jr." };
function add(over: Partial<NewItem> = {}): number {
  return db.insert(items).values({ kind: "card", title: "T", status: "confirmed", ...card, ...over }).returning({ id: items.id }).get().id;
}
const ids = (id: number) => findDuplicates(id, db).map((i) => i.id);

describe("findDuplicates", () => {
  it("matches ignoring case and whitespace", () => {
    const a = add({ status: "needs_review", player: " ken GRIFFEY jr. ", brand: "upper deck " });
    const b = add();
    expect(ids(a)).toEqual([b]);
  });

  it("does not match a different number, variation or grade", () => {
    const a = add({ status: "needs_review" });
    add({ cardNumber: "2" });
    add({ variation: "Tiffany" });
    add({ grader: "PSA", grade: "9" });
    expect(ids(a)).toEqual([]);
  });

  it("matches the same grade", () => {
    const a = add({ status: "needs_review", grader: "psa", grade: "9" });
    const b = add({ grader: "PSA", grade: "9" });
    expect(ids(a)).toEqual([b]);
  });

  it("does not offer needs_review items as targets", () => {
    const a = add({ status: "needs_review" });
    add({ status: "needs_review" });
    expect(ids(a)).toEqual([]);
  });

  it("never matches blank unidentified items", () => {
    const a = add({ status: "needs_review", year: null, brand: null, setName: null, cardNumber: null, player: null });
    add({ year: null, brand: null, setName: null, cardNumber: null, player: null });
    expect(ids(a)).toEqual([]);
  });

  it("matches sealed products and never bulk", () => {
    const sealed = { kind: "sealed", year: 1990, brand: "Topps", setName: "Series 1", sport: "baseball", productType: "box" } as const;
    const a = add({ ...sealed, status: "needs_review" });
    const b = add(sealed);
    add({ ...sealed, productType: "pack" });
    expect(ids(a)).toEqual([b]);
    const l1 = add({ kind: "bulk", status: "needs_review" });
    add({ kind: "bulk" });
    expect(ids(l1)).toEqual([]);
  });
});

describe("mergeInto", () => {
  it("adds quantities and removes the source with its rows", () => {
    const source = add({ status: "needs_review", quantity: 2 });
    const target = add({ quantity: 3 });
    db.insert(images).values({ itemId: source, role: "front", file: "a.jpg", thumbFile: "a-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(valuations).values({ itemId: source, source: "manual", valueCents: 100 }).run();
    const r = mergeInto(source, target, db);
    expect(r).toEqual({ ok: true, targetId: target, files: ["a.jpg"] });
    expect(db.select().from(items).where(eq(items.id, target)).get()?.quantity).toBe(5);
    expect(db.select().from(items).where(eq(items.id, source)).get()).toBeUndefined();
    expect(db.select().from(images).all()).toHaveLength(0);
    expect(db.select().from(valuations).all()).toHaveLength(0);
  });

  it("refuses non-duplicates, self and missing items", () => {
    const a = add({ status: "needs_review" });
    const b = add({ cardNumber: "9" });
    expect(mergeInto(a, b, db)).toMatchObject({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, a, db)).toMatchObject({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, 9999, db)).toMatchObject({ ok: false, error: "That item no longer exists." });
    expect(db.select().from(items).all()).toHaveLength(2);
  });

  it("refuses to go above the form's maximum and changes nothing", () => {
    const source = add({ status: "needs_review", quantity: 2 });
    const target = add({ quantity: MAX_QUANTITY - 1 });
    const r = mergeInto(source, target, db);
    expect(r).toMatchObject({ ok: false, problem: "too_many" });
    if (!r.ok) expect(r.error).toMatch(/100,000/);
    expect(db.select().from(items).where(eq(items.id, target)).get()?.quantity).toBe(MAX_QUANTITY - 1);
    expect(db.select().from(items).all()).toHaveLength(2);
    // Exactly the maximum is fine.
    const s2 = add({ status: "needs_review", quantity: 1 });
    expect(mergeInto(s2, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()?.quantity).toBe(MAX_QUANTITY);
  });

  it("keeps the source's value and history when the target has none", () => {
    const source = add({ status: "needs_review", estLowCents: 400, estHighCents: 800, estValueCents: 600, valueSource: "ai_estimate", valueBasis: "AI." });
    const target = add();
    db.insert(valuations).values({ itemId: source, source: "ai_estimate", valueCents: 600 }).run();
    expect(mergeInto(source, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()).toMatchObject({
      estLowCents: 400, estHighCents: 800, estValueCents: 600, valueSource: "ai_estimate", valueBasis: "AI.", quantity: 2,
    });
    expect(db.select().from(valuations).all()).toMatchObject([{ itemId: target, valueCents: 600 }]);
  });

  it("keeps the target's own value when it has one", () => {
    const source = add({ status: "needs_review", estValueCents: 600 });
    const target = add({ manualValueCents: 100 });
    expect(mergeInto(source, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()).toMatchObject({ manualValueCents: 100, estValueCents: null });
  });
});

describe("reviewCount", () => {
  it("counts items waiting", () => {
    expect(reviewCount(db)).toBe(0);
    add({ status: "needs_review" });
    add();
    expect(reviewCount(db)).toBe(1);
  });
});
