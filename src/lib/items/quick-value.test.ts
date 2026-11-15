import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, valuations } from "@/db/schema";
import { setQuickValue } from "./quick-value";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });
const add = () => db.insert(items).values({ kind: "card", title: "T" }).returning({ id: items.id }).get().id;

describe("setQuickValue", () => {
  it("saves the value and logs a manual valuation", () => {
    const id = add();
    expect(setQuickValue(id, "$12.50", db)).toEqual({ ok: true });
    const row = db.select().from(items).where(eq(items.id, id)).get()!;
    expect(row.manualValueCents).toBe(1250);
    const v = db.select().from(valuations).where(eq(valuations.itemId, id)).all();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ source: "manual", valueCents: 1250 });
  });
  it("rejects bad text and changes nothing", () => {
    const id = add();
    expect(setQuickValue(id, "abc", db)).toEqual({ ok: false, error: "Enter a dollar amount like 12.50" });
    expect(db.select().from(valuations).all()).toHaveLength(0);
  });
  it("reports an unknown item", () => {
    expect(setQuickValue(999, "5", db)).toEqual({ ok: false, error: "This item no longer exists." });
  });
});
