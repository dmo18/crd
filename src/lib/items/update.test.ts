import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, valuations, type NewItem } from "@/db/schema";
import { confirmItem, deleteItem, updateItem } from "./update";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

function insert(over: Partial<NewItem> = {}): number {
  return db.insert(items).values({ kind: "card", title: "Old", ...over }).returning({ id: items.id }).get().id;
}
const base = { quantity: "1" };
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;

describe("updateItem", () => {
  it("validates and rebuilds the title", () => {
    const id = insert();
    const r = updateItem(id, { ...base, year: "1989", brand: " Upper Deck ", cardNumber: "1", player: "Ken Griffey Jr.", isRookie: true }, db);
    expect(r).toEqual({ ok: true });
    const row = get(id);
    expect(row.title).toBe("1989 Upper Deck #1 Ken Griffey Jr.");
    expect(row.isRookie).toBe(true);
    expect(row.team).toBeNull();
  });

  it("ignores fields that do not fit the kind", () => {
    const id = insert({ kind: "sealed", productType: "box" });
    updateItem(id, { ...base, player: "Someone", productType: "pack", year: "1990", brand: "Topps" }, db);
    const row = get(id);
    expect(row.player).toBeNull();
    expect(row.productType).toBe("pack");
    expect(row.title).toBe("1990 Topps pack");
  });

  it("sets and clears a manual value, logging a valuation", () => {
    const id = insert({ estValueCents: 500 });
    updateItem(id, { ...base, manualValue: "$12.50" }, db);
    expect(get(id).manualValueCents).toBe(1250);
    const rows = db.select().from(valuations).where(eq(valuations.itemId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "manual", valueCents: 1250 });
    updateItem(id, { ...base, manualValue: "" }, db);
    expect(get(id).manualValueCents).toBeNull();
    expect(db.select().from(valuations).all()).toHaveLength(1);
  });

  it("rejects bad year, quantity and dollars with plain messages", () => {
    const id = insert();
    const r = updateItem(id, { quantity: "0", year: "1500", manualValue: "abc" }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.year).toMatch(/1860/);
      expect(r.errors.quantity).toMatch(/1 to 100,000/);
      expect(r.errors.manualValue).toBe("Enter a dollar amount like 12.50");
    }
    expect(get(id).title).toBe("Old");
  });

  it("reports an unknown item", () => {
    expect(updateItem(999, base, db)).toEqual({ ok: false, errors: { form: "This item no longer exists." } });
  });
});

describe("confirm and delete", () => {
  it("confirms an item", () => {
    const id = insert({ status: "needs_review" });
    expect(confirmItem(id, db)).toEqual({ ok: true });
    expect(get(id).status).toBe("confirmed");
  });

  it("deletes an item", async () => {
    const id = insert();
    expect(await deleteItem(id, db)).toEqual({ ok: true });
    expect(db.select().from(items).where(eq(items.id, id)).get()).toBeUndefined();
    expect((await deleteItem(id, db)).ok).toBe(false);
  });
});
