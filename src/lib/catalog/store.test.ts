import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogCards, catalogSources, items } from "@/db/schema";
import { addCardToCollection, saveCatalogCard, saveCatalogCardIn } from "./store";
import type { CatalogCard } from "./types";

const card = (over: Partial<CatalogCard> = {}): CatalogCard => ({
  source: "mycardfolio", sourceId: "551033", url: "https://example.test/551033", sourceSetId: "s1", verified: true,
  sport: "baseball", year: 1990, brand: "Topps", setName: "Topps", cardNumber: "336", player: "Ken Griffey Jr.", variation: null,
  ...over,
} as CatalogCard);

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });
afterEach(() => undefined);

describe("catalog store", () => {
  it("saves once and gives the same row back", () => {
    const a = saveCatalogCard(card(), db);
    const b = saveCatalogCard(card(), db);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(db.select().from(catalogCards).all()).toHaveLength(1);
    expect(db.select().from(catalogSources).all()).toHaveLength(1);
  });
  it("the inner version works inside the caller's own transaction", () => {
    const r = db.transaction((tx) => saveCatalogCardIn(tx as unknown as Db, card()), { behavior: "immediate" });
    expect(r.ok).toBe(true);
    expect(db.select().from(catalogCards).all()).toHaveLength(1);
  });
  it("refuses a card missing facts", () => {
    expect(saveCatalogCard(card({ player: null }), db)).toMatchObject({ ok: false });
    expect(db.select().from(catalogCards).all()).toHaveLength(0);
  });
  it("add to collection: one catalog card, two items for two adds, none on failure", () => {
    const a = addCardToCollection(card(), db);
    const b = addCardToCollection(card(), db);
    expect(a.ok && b.ok).toBe(true);
    expect(db.select().from(catalogCards).all()).toHaveLength(1);
    expect(db.select().from(items).all()).toHaveLength(2);
    expect(addCardToCollection(card({ sourceId: "9", brand: null }), db)).toMatchObject({ ok: false });
    expect(db.select().from(items).all()).toHaveLength(2);
  });
});
