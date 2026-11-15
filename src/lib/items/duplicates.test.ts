import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, valuations, type NewItem } from "@/db/schema";
import { findDuplicates, mergeInto, reviewCount } from "./duplicates";

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
    expect(mergeInto(a, b, db)).toEqual({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, a, db)).toEqual({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, 9999, db)).toEqual({ ok: false, error: "That item no longer exists." });
    expect(db.select().from(items).all()).toHaveLength(2);
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
