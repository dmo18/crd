import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogCards, items, valuations } from "@/db/schema";
import { linkCatalogCard, unlinkCatalogCard } from "@/lib/catalog/apply";
import { createItem, NEEDS_ONE } from "./create";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;

describe("createItem (add by hand)", () => {
  it("accepts a nearly empty record: only a player", () => {
    const r = createItem("card", { player: "Ken Griffey Jr." }, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = get(r.id);
    expect(row).toMatchObject({ kind: "card", status: "confirmed", quantity: 1, player: "Ken Griffey Jr.", title: "Ken Griffey Jr.", catalogCardId: null });
    expect(JSON.parse(row.fieldSources!)).toEqual({ player: "owner" });
  });
  it("accepts only a description, for a card and for a bulk lot", () => {
    const a = createItem("card", { description: "Old card from grandpa" }, db);
    const b = createItem("bulk", { description: "Shoebox of 80s cards" }, db);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(get(a.id).description).toBe("Old card from grandpa");
    if (b.ok) expect(get(b.id).title).toBe("Bulk lot, Shoebox of 80s cards");
  });
  it("accepts only a set name", () => {
    expect(createItem("sealed", { setName: "1990 Topps wax box" }, db).ok).toBe(true);
  });
  it("refuses a fully empty record and a record with only a year", () => {
    expect(createItem("card", {}, db)).toEqual({ ok: false, errors: { form: NEEDS_ONE } });
    expect(createItem("card", { year: "1990", brand: "Topps", quantity: "1" }, db)).toEqual({ ok: false, errors: { form: NEEDS_ONE } });
    expect(db.select().from(items).all()).toHaveLength(0);
  });
  it("refuses a bad kind, a bad year and a missing location", () => {
    expect(createItem("coin", { player: "x" }, db).ok).toBe(false);
    const bad = createItem("card", { player: "x", year: "1500" }, db);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.year).toMatch(/1860/);
    const loc = createItem("card", { player: "x", locationId: "55" }, db);
    expect(loc.ok).toBe(false);
  });
  it("marks every filled field owner and records a manual value", () => {
    const r = createItem("card", { player: "Cal Ripken", year: "1983", brand: "Topps", team: "Orioles", manualValue: "12.50" }, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(get(r.id).fieldSources!)).toEqual({ year: "owner", brand: "owner", player: "owner", team: "owner" });
    expect(get(r.id).manualValueCents).toBe(1250);
    expect(db.select().from(valuations).where(eq(valuations.itemId, r.id)).all()).toHaveLength(1);
  });
  it("ignores fields that do not fit the kind", () => {
    const r = createItem("sealed", { setName: "Box", player: "Nobody", estCount: "500" }, db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(get(r.id)).toMatchObject({ player: null, estCount: null, productType: "other" });
  });
});

describe("link later and unlink", () => {
  const catalog = () => db.insert(catalogCards).values({
    canonicalKey: "k", sport: "baseball", year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr.", team: "Mariners", verified: true,
  }).returning({ id: catalogCards.id }).get().id;

  it("keeps the owner's player and team, fills empty year and number", () => {
    const r = createItem("card", { player: "Junior", team: "M's" }, db);
    if (!r.ok) throw new Error("create");
    const res = linkCatalogCard(r.id, catalog(), db);
    expect(res.ok).toBe(true);
    expect(get(r.id)).toMatchObject({ player: "Junior", team: "M's", year: 1990, cardNumber: "336", brand: "Topps" });
    expect(get(r.id).catalogCardId).not.toBeNull();
    expect(JSON.parse(get(r.id).fieldSources!)).toMatchObject({ player: "owner", team: "owner", year: "catalog", cardNumber: "catalog" });
  });
  it("unlink changes no field", () => {
    const r = createItem("card", { player: "Junior" }, db);
    if (!r.ok) throw new Error("create");
    linkCatalogCard(r.id, catalog(), db);
    const before = { ...get(r.id), catalogCardId: null, updatedAt: null };
    expect(unlinkCatalogCard(r.id, db).ok).toBe(true);
    expect({ ...get(r.id), updatedAt: null }).toEqual(before);
  });
});
