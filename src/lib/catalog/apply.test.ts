import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogCards, catalogSources, items, valuations, type Item, type NewItem } from "@/db/schema";
import { applyBulk, undoBulk } from "@/lib/items/bulk";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { updateItem } from "@/lib/items/update";
import { recognizedItemSchema } from "@/lib/recognition/types";
import { applyCatalogCard, linkCatalogCard, unlinkCatalogCard } from "./apply";
import { canonicalKey } from "./key";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const T0 = new Date("2026-11-16T10:00:00Z");
const later = (min: number) => new Date(T0.getTime() + min * 60_000);
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
const marks = (row: Item) => (row.fieldSources ? JSON.parse(row.fieldSources) : null);

function insert(over: Partial<NewItem> = {}): Item {
  const id = db.insert(items).values({ kind: "card", title: "Old", createdAt: T0, updatedAt: T0, ...over }).returning({ id: items.id }).get().id;
  return get(id);
}

/** 1990 Topps #336 Ken Griffey Jr., as the catalog has it. */
function griffeyCard(over: Partial<typeof catalogCards.$inferInsert> = {}) {
  const values = { sport: "baseball" as const, year: 1990, brand: "Topps", setName: null, cardNumber: "336", player: "Ken Griffey Jr.", ...over };
  const card = db.insert(catalogCards).values({ ...values, canonicalKey: canonicalKey(values)!, verified: true }).returning().get();
  db.insert(catalogSources).values({
    catalogCardId: card.id, source: "mycardfolio", sourceId: String(551033 + card.id), url: "https://mycardfolio.com/card/x", sourceSetId: "9179", fetchedAt: T0,
  }).run();
  return card;
}

/** An item as a scan makes it: every filled field marked `reading`. */
function scanned(read: Record<string, unknown>): Item {
  const r = recognizedItemSchema.parse({ kind: "card", confidence: 0.5, ...read });
  const row = itemFromRecognition(r, { scanId: null as unknown as number, locationId: null, valueSource: "ai_estimate", now: T0, recognizer: "free" });
  return get(db.insert(items).values(row).returning({ id: items.id }).get().id);
}

describe("applyCatalogCard (the filling rule)", () => {
  it("rule 1: fills empty fields and marks them catalog", () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990 });
    const r = applyCatalogCard(item, griffeyCard());
    expect(r.patch).toMatchObject({ sport: "baseball", brand: "Topps", cardNumber: "336", catalogCardId: 1 });
    expect(r.filled).toEqual(["sport", "brand", "cardNumber"]);
    expect(JSON.parse(r.patch.fieldSources!)).toEqual({ player: "reading", year: "reading", sport: "catalog", brand: "catalog", cardNumber: "catalog" });
    expect(r.differences).toEqual([]);
    // Fields the catalog does not have stay out of the patch: nothing is emptied.
    expect(r.patch).not.toHaveProperty("team");
    expect(r.patch).not.toHaveProperty("setName");
  });

  it("rule 2: never changes a field marked owner, and does not list it", () => {
    const item = insert({ player: "Junior", year: 1989, fieldSources: JSON.stringify({ player: "owner", year: "owner" }) });
    const r = applyCatalogCard(item, griffeyCard(), { useCatalogValues: true });
    expect(r.patch).not.toHaveProperty("player");
    expect(r.patch).not.toHaveProperty("year");
    expect(r.differences).toEqual([]);
    expect(r.replaced).toEqual([]);
    expect(JSON.parse(r.patch.fieldSources!)).toMatchObject({ player: "owner", year: "owner", brand: "catalog" });
  });

  it("rule 2: an old item with null sources is never overwritten, only its empty fields are filled", () => {
    const item = insert({ player: "Ken Grifey", year: 1989, team: "Twins", brand: "Tops" });
    expect(item.fieldSources).toBeNull();
    for (const useCatalogValues of [false, true]) {
      const r = applyCatalogCard(item, griffeyCard({ team: "Mariners", cardNumber: useCatalogValues ? "336" : "337" }), { useCatalogValues });
      expect(Object.keys(r.patch).sort()).toEqual(["cardNumber", "catalogCardId", "fieldSources", "sport", "title"]);
      expect(r.differences).toEqual([]);
      expect(JSON.parse(r.patch.fieldSources!)).toEqual({ sport: "catalog", cardNumber: "catalog" });
    }
    // In the database too.
    expect(linkCatalogCard(item.id, 1, db, { useCatalogValues: true })).toEqual({ ok: true, differences: [] });
    expect(get(item.id)).toMatchObject({ player: "Ken Grifey", year: 1989, team: "Twins", brand: "Tops", sport: "baseball", cardNumber: "337", catalogCardId: 1 });
  });

  it("rule 2: an old item with every field filled gets the link and nothing else", () => {
    const item = insert({ sport: "baseball", player: "K. Griffey", year: 1990, brand: "Topps", cardNumber: "1", title: "1990 Topps #1 K. Griffey" });
    const r = applyCatalogCard(item, griffeyCard());
    expect(r.patch).toEqual({ catalogCardId: 1 });
  });

  it("rule 3: a reading field that differs is not changed by the pick, only listed", () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", team: "Twins", cardNumber: "386" });
    const r = applyCatalogCard(item, griffeyCard({ team: "Mariners" }));
    expect(r.differences).toEqual([
      { field: "cardNumber", itemValue: "386", catalogValue: "336" },
      { field: "team", itemValue: "Twins", catalogValue: "Mariners" },
    ]);
    expect(r.patch).not.toHaveProperty("team");
    expect(r.patch).not.toHaveProperty("cardNumber");
    expect(JSON.parse(r.patch.fieldSources!)).toMatchObject({ team: "reading", cardNumber: "reading", sport: "catalog" });
  });

  it("rule 3: \"Use the catalog's values\" changes only those reading fields", () => {
    const item = scanned({ player: "ken griffey jr.", year: 1990, brand: "Topps", team: "Twins", cardNumber: "386" });
    const withOwner = { ...item, variation: "Signed by him", fieldSources: JSON.stringify({ ...marks(item), variation: "owner" }) };
    const r = applyCatalogCard(withOwner, griffeyCard({ team: "Mariners", variation: "Tiffany" }), { useCatalogValues: true });
    expect(r.replaced).toEqual(["cardNumber", "team"]);
    expect(r.differences).toEqual([]);
    expect(r.patch).toMatchObject({ team: "Mariners", cardNumber: "336" });
    // Same value in other capitals is no difference; the owner's variation stays.
    expect(r.patch).not.toHaveProperty("player");
    expect(r.patch).not.toHaveProperty("variation");
    expect(JSON.parse(r.patch.fieldSources!)).toEqual({
      player: "reading", year: "reading", brand: "reading", team: "catalog", cardNumber: "catalog", sport: "catalog", variation: "owner",
    });
  });

  it("keeps fields from the key list and Wikidata as they are", () => {
    const item = insert({ player: "Ken Griffey Jr.", team: "Seattle Mariners", cardNumber: "1", fieldSources: JSON.stringify({ player: "key_list", team: "wikidata", cardNumber: "key_list" }) });
    const r = applyCatalogCard(item, griffeyCard({ team: "Mariners" }), { useCatalogValues: true });
    expect(r.patch).not.toHaveProperty("team");
    expect(r.patch).not.toHaveProperty("cardNumber");
    expect(r.differences).toEqual([]);
  });

  it("rule 4: rebuilds the title, adds no value row and leaves the first suggestion alone", () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, estimate: { lowCents: 100, highCents: 300, basis: null } });
    const first = item.firstSuggestion;
    expect(first).not.toBeNull();
    const card = griffeyCard();
    const pure = applyCatalogCard(item, card);
    expect(pure.patch.title).toBe("1990 Topps #336 Ken Griffey Jr.");
    expect(pure.patch).not.toHaveProperty("firstSuggestion");
    expect(Object.keys(pure.patch).filter((k) => /cents|value|status|confidence/i.test(k))).toEqual([]);

    expect(linkCatalogCard(item.id, card.id, db, { now: later(5) })).toEqual({ ok: true, differences: [] });
    const row = get(item.id);
    expect(row).toMatchObject({
      title: "1990 Topps #336 Ken Griffey Jr.", catalogCardId: card.id, firstSuggestion: first, status: "needs_review",
      estValueCents: 200, estLowCents: 100, estHighCents: 300, confidence: 0.5,
    });
    expect(row.updatedAt).toEqual(later(5));
    expect(db.select().from(valuations).all()).toHaveLength(0);
  });

  it("is pure: the item and the card it was given are not changed", () => {
    const item = scanned({ player: "Ken Griffey Jr." });
    const copy = structuredClone(item);
    applyCatalogCard(item, griffeyCard(), { useCatalogValues: true });
    expect(item).toEqual(copy);
  });
});

describe("linkCatalogCard and unlinkCatalogCard", () => {
  it("refuses a missing item, a deleted item, a missing card and other kinds", () => {
    const card = griffeyCard();
    expect(linkCatalogCard(999, card.id, db)).toEqual({ ok: false, error: "This item no longer exists." });
    const gone = insert({ deletedAt: T0 });
    expect(linkCatalogCard(gone.id, card.id, db)).toEqual({ ok: false, error: "This item no longer exists." });
    const item = insert();
    expect(linkCatalogCard(item.id, 999, db)).toEqual({ ok: false, error: "That catalog card no longer exists." });
    const box = insert({ kind: "sealed" });
    expect(linkCatalogCard(box.id, card.id, db).ok).toBe(false);
    expect(get(box.id).catalogCardId).toBeNull();
  });

  it("unlinking sets the link to null and changes no other field", () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990 });
    const card = griffeyCard();
    linkCatalogCard(item.id, card.id, db, { now: later(5) });
    const linked = get(item.id);
    expect(unlinkCatalogCard(item.id, db)).toEqual({ ok: true });
    expect(get(item.id)).toEqual({ ...linked, catalogCardId: null });
    expect(unlinkCatalogCard(999, db)).toEqual({ ok: false });
  });

  it("deleting a catalog card unlinks its items and removes its source rows", () => {
    const item = insert({ player: "Ken Griffey Jr." });
    const card = griffeyCard();
    linkCatalogCard(item.id, card.id, db);
    db.delete(catalogCards).where(eq(catalogCards.id, card.id)).run();
    expect(get(item.id)).toMatchObject({ catalogCardId: null, player: "Ken Griffey Jr.", brand: "Topps" });
    expect(db.select().from(catalogSources).all()).toHaveLength(0);
  });

  it("allows one catalog card per key and one row per source id", () => {
    const card = griffeyCard();
    expect(() => griffeyCard()).toThrow(/UNIQUE/);
    expect(() => db.insert(catalogSources).values({ catalogCardId: card.id, source: "mycardfolio", sourceId: String(551033 + card.id), fetchedAt: T0 }).run()).toThrow(/UNIQUE/);
  });
});

describe("owner edits and the first suggestion", () => {
  it("a single edit marks the changed fields owner and leaves the rest and the first suggestion", () => {
    const item = scanned({ player: "Ken Grifey", year: 1990, brand: "Topps", team: "Twins" });
    const first = item.firstSuggestion;
    expect(updateItem(item.id, { quantity: "1", player: "Ken Griffey Jr.", year: "1990", brand: "Topps", team: "", cardNumber: "336" }, db)).toEqual({ ok: true });
    const row = get(item.id);
    expect(marks(row)).toEqual({ player: "owner", year: "reading", brand: "reading", cardNumber: "owner" });
    expect(row.firstSuggestion).toBe(first);
    // The catalog may then not touch the owner's player, even when asked to use its values.
    const card = griffeyCard({ player: "Ken Griffey Sr.", cardNumber: "999" });
    linkCatalogCard(item.id, card.id, db, { useCatalogValues: true });
    expect(get(item.id)).toMatchObject({ player: "Ken Griffey Jr.", cardNumber: "336", firstSuggestion: first });
  });

  it("a single edit of an old item writes no marks", () => {
    const item = insert({ player: "A" });
    updateItem(item.id, { quantity: "1", player: "B", team: "C" }, db);
    expect(get(item.id)).toMatchObject({ player: "B", team: "C", fieldSources: null, firstSuggestion: null });
  });

  it("a bulk change marks the field owner, undo puts the old mark back, and the first suggestion never changes", () => {
    const a = scanned({ player: "Ken Griffey Jr.", team: "Twins" });
    const b = scanned({ player: "Ken Griffey Jr.", team: "Twins" });
    const old = insert({ player: "Old", team: "Twins" });
    const first = a.firstSuggestion;
    const r = applyBulk({ ids: [a.id, b.id, old.id] }, { type: "set", field: "team", value: "Mariners", onlyEmpty: false }, db, later(1));
    if ("error" in r) throw new Error(r.error);
    expect(r.changed).toBe(3);
    expect(marks(get(a.id))).toEqual({ player: "reading", team: "owner" });
    expect(get(a.id).firstSuggestion).toBe(first);
    expect(get(old.id)).toMatchObject({ team: "Mariners", fieldSources: null });

    const rep = applyBulk({ ids: [b.id] }, { type: "replace", field: "player", find: "Jr.", replace: "Junior", matchCase: true }, db, later(2));
    if ("error" in rep) throw new Error(rep.error);
    expect(marks(get(b.id))).toEqual({ player: "owner", team: "owner" });

    const u = undoBulk(rep.opId, db, later(3));
    expect(u).toMatchObject({ restored: 1, skipped: 0 });
    expect(get(b.id)).toMatchObject({ player: "Ken Griffey Jr.", firstSuggestion: b.firstSuggestion });
    expect(marks(get(b.id))).toEqual({ player: "reading", team: "owner" });

    // Changes that are not about a catalog field write no marks.
    const st = applyBulk({ ids: [a.id] }, { type: "status", status: "confirmed" }, db, later(4));
    if ("error" in st) throw new Error(st.error);
    const notes = applyBulk({ ids: [a.id] }, { type: "set", field: "notes", value: "x", onlyEmpty: false }, db, later(5));
    if ("error" in notes) throw new Error(notes.error);
    expect(marks(get(a.id))).toEqual({ player: "reading", team: "owner" });
    expect(get(a.id).firstSuggestion).toBe(first);
  });

  it("the first suggestion is the same after an edit, a bulk edit and a pick", () => {
    const item = scanned({ player: "Ken Grifey", year: 1990, brand: "Topps" });
    const first = item.firstSuggestion!;
    expect(JSON.parse(first)).toEqual({ v: 1, fields: { player: "Ken Grifey", year: 1990, brand: "Topps" }, confidence: 0.5, reader: "free", at: T0.getTime() });
    updateItem(item.id, { quantity: "1", player: "Ken Griffey", year: "1990", brand: "Topps" }, db);
    expect(get(item.id).firstSuggestion).toBe(first);
    const r = applyBulk({ ids: [item.id] }, { type: "set", field: "brand", value: "Topps Co", onlyEmpty: false }, db, later(1));
    if ("error" in r) throw new Error(r.error);
    expect(get(item.id).firstSuggestion).toBe(first);
    const card = griffeyCard();
    expect(linkCatalogCard(item.id, card.id, db, { useCatalogValues: true, now: later(2) }).ok).toBe(true);
    const row = get(item.id);
    expect(row.firstSuggestion).toBe(first);
    expect(row).toMatchObject({ player: "Ken Griffey", brand: "Topps Co", year: 1990, cardNumber: "336", catalogCardId: card.id });
    unlinkCatalogCard(item.id, db);
    expect(get(item.id).firstSuggestion).toBe(first);
  });
});
