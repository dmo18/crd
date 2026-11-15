import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, locations } from "@/db/schema";
import { createLocation, deleteLocation, listLocations, renameLocation } from "./locations";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const make = (name: string) => {
  const r = createLocation({ name, kind: "", notes: "" }, db);
  if (!r.ok) throw new Error("setup failed");
  return r.id;
};

describe("locations", () => {
  it("creates with trimmed name and empty kind/notes as null", () => {
    const id = make("  Box 1 ");
    expect(listLocations(db)[0]).toMatchObject({ id, name: "Box 1", kind: null, notes: null, itemCount: 0, unitCount: 0, totalValueCents: 0 });
  });

  it("validates name, kind and notes", () => {
    expect(createLocation({ name: "  ", kind: "", notes: "" }, db)).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(createLocation({ name: "x".repeat(61), kind: "", notes: "" }, db).ok).toBe(false);
    expect(createLocation({ name: "A", kind: "Closet", notes: "" }, db)).toMatchObject({ ok: false, errors: { kind: expect.any(String) } });
    expect(createLocation({ name: "A", kind: "Box", notes: "n".repeat(301) }, db)).toMatchObject({ ok: false, errors: { notes: expect.any(String) } });
    expect(createLocation({ name: "A", kind: "Safe", notes: "ok" }, db).ok).toBe(true);
  });

  it("rejects duplicate names case-insensitively, but allows keeping its own name", () => {
    const id = make("Box 1");
    expect(createLocation({ name: "box 1", kind: "", notes: "" }, db)).toEqual({
      ok: false, errors: { name: "You already have a location with that name." },
    });
    expect(renameLocation(id, { name: "BOX 1", kind: "Box", notes: "" }, db).ok).toBe(true);
    const other = make("Box 2");
    expect(renameLocation(other, { name: "box 1", kind: "", notes: "" }, db).ok).toBe(false);
  });

  it("renames and reports a missing location", () => {
    const id = make("Old");
    expect(renameLocation(id, { name: "New", kind: "Shelf", notes: "top" }, db).ok).toBe(true);
    expect(listLocations(db)[0]).toMatchObject({ name: "New", kind: "Shelf", notes: "top" });
    expect(renameLocation(999, { name: "X", kind: "", notes: "" }, db).ok).toBe(false);
  });

  it("counts items, units and value, and orders by name ignoring case", () => {
    const b = make("banana");
    const a = make("Apple");
    db.insert(items).values([
      { kind: "card", title: "a", locationId: a, quantity: 2, estValueCents: 500 },
      { kind: "card", title: "b", locationId: a, quantity: 1, estValueCents: 500, manualValueCents: 1000 },
      { kind: "card", title: "c", locationId: a, quantity: 3 },
      { kind: "card", title: "d", locationId: null, quantity: 9, estValueCents: 999 },
    ]).run();
    const list = listLocations(db);
    expect(list.map((l) => l.name)).toEqual(["Apple", "banana"]);
    expect(list[0]).toMatchObject({ itemCount: 3, unitCount: 6, totalValueCents: 2000 });
    expect(list[1]).toMatchObject({ id: b, itemCount: 0, unitCount: 0, totalValueCents: 0 });
  });

  it("deleting keeps items and clears their location", () => {
    const id = make("Box");
    const itemId = db.insert(items).values({ kind: "card", title: "t", locationId: id }).returning({ id: items.id }).get().id;
    expect(deleteLocation(id, db)).toEqual({ ok: true });
    expect(listLocations(db)).toHaveLength(0);
    const row = db.select().from(items).where(eq(items.id, itemId)).get();
    expect(row).toBeDefined();
    expect(row!.locationId).toBeNull();
    expect(deleteLocation(id, db).ok).toBe(false);
  });
});

describe("unique location names in the database", () => {
  it("refuses a second name differing only in capitals, even past the early check", () => {
    make("Box 1");
    expect(() => db.insert(locations).values({ name: "BOX 1" }).run()).toThrow(/UNIQUE/i);
  });
  it("turns a constraint error from a racing save into the plain message", () => {
    make("Box 1");
    // The early check finds nothing, as when another save lands right after it.
    const racing = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "select") return () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) });
        return Reflect.get(target, prop, recv);
      },
    });
    expect(createLocation({ name: "box 1", kind: "", notes: "" }, racing)).toEqual({ ok: false, errors: { name: "You already have a location with that name." } });
  });
});
