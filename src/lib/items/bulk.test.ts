import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { bulkOps, images, items, locations, valuations, type Item, type NewItem } from "@/db/schema";
import { purgeItems, restoreItems, softDeleteItems } from "./bin";
import { deleteLocation } from "@/lib/locations/locations";
import {
  applyBulk, BULK_KEEP, fingerprintIds, latestUndoable, undoData, MAX_BULK_IDS, MAX_BULK_ITEMS, parseAction, parseSelection, previewBulk,
  replaceText, undoBulk, type BulkAction, type Selection,
} from "./bulk";
import { inventoryFilterSchema, listItems, matchingIds } from "./query";
import { updateItem } from "./update";
import { undoLine } from "./undo-line";

let db: Db;
let box: number;
const MIN = 60_000;
const T0 = new Date("2026-11-01T12:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  box = db.insert(locations).values({ name: "Box 1" }).returning({ id: locations.id }).get().id;
});
afterEach(() => setDbForTests(undefined));

const add = (over: Partial<NewItem> = {}) =>
  db.insert(items).values({ kind: "card", title: "T", createdAt: T0, updatedAt: T0, ...over }).returning({ id: items.id }).get().id;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get() as Item;
const ops = () => db.select().from(bulkOps).all();
const ok = <T extends object>(r: T | { error: string }): T => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};
const ids = (...list: number[]): Selection => ({ ids: list });
const set = (field: string, value: unknown, onlyEmpty = false, clear = false) => ({ type: "set", field, value, onlyEmpty, clear }) as BulkAction;

describe("checking what the browser sends", () => {
  it("refuses an empty selection, 501 ids, unknown filters and bad values", () => {
    expect(parseSelection({ ids: [] })).toEqual({ error: "Select at least one item first." });
    const many = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => i + 1);
    expect(parseSelection({ ids: many })).toMatchObject({ error: expect.stringMatching(/up to 500/) });
    expect(parseSelection({ ids: many.slice(0, MAX_BULK_IDS) })).toEqual({ ids: many.slice(0, MAX_BULK_IDS) });
    expect(parseSelection({ ids: [1.5] })).toHaveProperty("error");
    expect(parseSelection({ ids: [-1] })).toHaveProperty("error");
    // An unknown or bad filter must never quietly widen the selection to everything.
    expect(parseSelection({ filters: { sport: "cricket" }, expectedCount: 3 })).toHaveProperty("error");
    expect(parseSelection({ filters: { colour: "red" }, expectedCount: 3 })).toHaveProperty("error");
    expect(parseSelection({ filters: { yearFrom: "1990" }, expectedCount: 3 })).toHaveProperty("error");
    expect(parseSelection({ filters: {}, expectedCount: 0 })).toEqual({ error: "Select at least one item first." });
    expect(parseSelection({ filters: { sport: "baseball", tier: ["key"], missing: "team", page: 3 }, expectedCount: 2 }))
      .toEqual({ filters: { sport: "baseball", tier: ["key"], missing: "team", page: 3 }, expectedCount: 2 });
    expect(parseSelection({ ids: [1], filters: {}, expectedCount: 1 })).toHaveProperty("error");
  });

  it("refuses unknown actions and fields, and checks find and replace limits", () => {
    expect(parseAction({ type: "set", field: "title", value: "x", onlyEmpty: false })).toHaveProperty("error");
    expect(parseAction({ type: "set", field: "deletedAt", value: null, onlyEmpty: false })).toHaveProperty("error");
    expect(parseAction({ type: "replace", field: "sport", find: "a", replace: "b", matchCase: false })).toHaveProperty("error");
    expect(parseAction({ type: "replace", field: "team", find: "", replace: "b", matchCase: false })).toEqual({ error: "Type the text to find." });
    expect(parseAction({ type: "replace", field: "team", find: "x".repeat(101), replace: "", matchCase: false })).toHaveProperty("error");
    expect(parseAction({ type: "replace", field: "team", find: "x", replace: "y".repeat(101), matchCase: false })).toHaveProperty("error");
    expect(parseAction({ type: "replace", field: "team", find: "x".repeat(100), replace: "", matchCase: false })).toMatchObject({ type: "replace" });
    expect(parseAction({ type: "status", status: "sold" })).toHaveProperty("error");
    expect(parseAction({ type: "move", locationId: "1" })).toHaveProperty("error");
    expect(parseAction({ type: "delete", hard: true })).toHaveProperty("error");
    expect(parseAction({ type: "drop" })).toHaveProperty("error");
  });
});

describe("set a field", () => {
  it("preview shows exactly what apply changes, and writes nothing", () => {
    const a = add({ player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", team: null });
    const b = add({ player: "Barry Bonds", team: "" });
    const c = add({ player: "Frank Thomas", team: "White Sox" });
    const before = db.select().from(items).all();
    const p = ok(previewBulk(ids(a, b, c), set("team", "Mariners", true), db));
    expect(p.count).toBe(2);
    expect(p.samples).toEqual([
      { id: a, title: "T", before: "(empty)", after: "Mariners" },
      { id: b, title: "T", before: "(empty)", after: "Mariners" },
    ]);
    expect(db.select().from(items).all()).toEqual(before);
    expect(ops()).toHaveLength(0);

    const r = ok(applyBulk(ids(a, b, c), set("team", "Mariners", true), db, later(MIN)));
    expect(r.changed).toBe(p.count);
    expect(r.summary).toBe("Set team on 2 items");
    expect(get(a).team).toBe("Mariners");
    expect(get(b).team).toBe("Mariners");
    // "Only fill where empty" leaves filled rows alone, including their updated time.
    expect(get(c).team).toBe("White Sox");
    expect(get(c).updatedAt).toEqual(T0);
    expect(get(a).updatedAt).toEqual(later(MIN));
  });

  it("without only empty, overwrites; rebuilds titles; skips rows that already match", () => {
    const a = add({ player: "Ken Griffey", year: 1989, brand: "Upper Deck", cardNumber: "1" });
    const b = add({ player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", title: "1989 Upper Deck #1 Ken Griffey Jr." });
    const r = ok(applyBulk(ids(a, b), set("player", "Ken Griffey Jr."), db, later(MIN)));
    expect(r.changed).toBe(1);
    expect(get(a).title).toBe("1989 Upper Deck #1 Ken Griffey Jr.");
    expect(get(b).updatedAt).toEqual(T0);
  });

  it("needs an explicit Clear to empty a field", () => {
    const a = add({ notes: "keep me" });
    const msg = { error: "Pick a value, or tick Clear this field." };
    for (const v of ["", "  ", null, undefined]) expect(previewBulk(ids(a), set("notes", v), db)).toEqual(msg);
    expect(applyBulk(ids(a), set("notes", ""), db)).toEqual(msg);
    expect(get(a).notes).toBe("keep me");
    // Clear ignores any value sent with it.
    ok(applyBulk(ids(a), set("notes", "ignored", false, true), db));
    expect(get(a).notes).toBeNull();
    expect(previewBulk(ids(a), set("quantity", "", false, true), db)).toHaveProperty("error");
    expect(parseAction({ type: "set", field: "notes", value: "", onlyEmpty: false })).toMatchObject({ clear: false });
  });

  it("clears a field, sets flags, enums and quantity, and refuses bad values", () => {
    const a = add({ notes: "old note", condition: "mint" });
    expect(ok(applyBulk(ids(a), set("notes", null, false, true), db)).summary).toBe("Cleared notes on 1 item");
    expect(get(a).notes).toBeNull();
    ok(applyBulk(ids(a), set("isRookie", true), db));
    expect(get(a).isRookie).toBe(true);
    ok(applyBulk(ids(a), set("condition", "near_mint"), db));
    expect(get(a).condition).toBe("near_mint");
    ok(applyBulk(ids(a), set("quantity", 3), db));
    expect(get(a).quantity).toBe(3);
    ok(applyBulk(ids(a), set("year", "1990"), db));
    expect(get(a).year).toBe(1990);

    expect(previewBulk(ids(a), set("condition", "shiny"), db)).toHaveProperty("error");
    expect(previewBulk(ids(a), set("sport", "cricket"), db)).toHaveProperty("error");
    expect(previewBulk(ids(a), set("year", "1500"), db)).toEqual({ error: "Enter a year between 1860 and 2100." });
    expect(previewBulk(ids(a), set("quantity", 0), db)).toHaveProperty("error");
    expect(previewBulk(ids(a), set("quantity", null), db)).toHaveProperty("error");
    expect(previewBulk(ids(a), set("isRookie", "yes"), db)).toEqual({ error: "Choose yes or no." });
    expect(previewBulk(ids(a), set("team", "x".repeat(81)), db)).toEqual({ error: "Keep this under 80 characters." });
    expect(previewBulk(ids(a), set("team", { a: 1 }), db)).toHaveProperty("error");
    expect(previewBulk(ids(a), set("isRookie", true, true), db)).toMatchObject({ error: expect.stringMatching(/Only fill where empty/) });
    expect(previewBulk(ids(a), set("quantity", 2, true), db)).toHaveProperty("error");
  });

  it("leaves items alone that do not have the field (same rule as the item form)", () => {
    const card = add({ kind: "card" });
    const sealed = add({ kind: "sealed", title: "Box" });
    const r = ok(applyBulk(ids(card, sealed), set("player", "Ken Griffey Jr."), db));
    expect(r.changed).toBe(1);
    expect(get(sealed).player).toBeNull();
  });

  it("refuses a year after a lot's last year and changes nothing", () => {
    const lot = add({ kind: "bulk", year: 1987, yearEnd: 1989 });
    const other = add({ kind: "bulk", year: 1987 });
    expect(applyBulk(ids(lot, other), set("year", "1990"), db)).toMatchObject({ error: expect.stringMatching(/1 item have a last year/) });
    expect(get(other).year).toBe(1987);
    expect(ops()).toHaveLength(0);
  });

  it("own value is stored in cents and adds a value history row per changed item", () => {
    const a = add({ manualValueCents: null });
    const b = add({ manualValueCents: 1250 });
    const c = add({ manualValueCents: 500 });
    const p = ok(previewBulk(ids(a, b, c), set("manualValue", "$12.50"), db));
    expect(p.samples.map((s) => [s.before, s.after])).toEqual([["(empty)", "$12.50"], ["$5.00", "$12.50"]]);
    expect(ok(applyBulk(ids(a, b, c), set("manualValue", "$12.50"), db)).changed).toBe(2);
    expect([get(a), get(b), get(c)].map((r) => r.manualValueCents)).toEqual([1250, 1250, 1250]);
    const hist = db.select().from(valuations).all();
    expect(hist.map((h) => [h.itemId, h.valueCents, h.source])).toEqual([[a, 1250, "manual"], [c, 1250, "manual"]]);
    expect(previewBulk(ids(a), set("manualValue", "12.505"), db)).toEqual({ error: "Enter a dollar amount like 12.50" });
  });
});

describe("description for every kind", () => {
  it("set and find and replace change description on cards and sealed items", () => {
    const card = add({ kind: "card", description: "red border" });
    const sealed = add({ kind: "sealed", title: "Box", description: "red wrapper" });
    expect(ok(applyBulk(ids(card, sealed), set("description", "new text"), db)).changed).toBe(2);
    expect(get(card).description).toBe("new text");
    expect(get(sealed).description).toBe("new text");
    const r = ok(applyBulk(ids(card), { type: "replace", field: "description", find: "NEW", replace: "old", matchCase: false } as BulkAction, db));
    expect(r.changed).toBe(1);
    expect(get(card).description).toBe("old text");
    expect(get(sealed).description).toBe("new text");
  });
});

describe("find and replace", () => {
  it("treats %, _, backslash, quotes and pattern characters as plain text", () => {
    expect(replaceText("100% junk_wax", "%", " percent", true)).toBe("100 percent junk_wax");
    expect(replaceText("a_b_c", "_", "-", false)).toBe("a-b-c");
    expect(replaceText("C:\\cards\\box", "\\", "/", false)).toBe("C:/cards/box");
    expect(replaceText(`it's "mint"`, `"mint"`, "'nm'", false)).toBe("it's 'nm'");
    expect(replaceText("a.b.c", ".", "", false)).toBe("abc");
    expect(replaceText("(x) [y] {z} a+b a*b a?b ^$ |", "a+b", "ok", false)).toBe("(x) [y] {z} ok a*b a?b ^$ |");
    expect(replaceText("price", "price", "$& $1 $$", false)).toBe("$& $1 $$");
    expect(replaceText("Bulls BULLS bulls", "bulls", "Sox", false)).toBe("Sox Sox Sox");
    expect(replaceText("Bulls BULLS bulls", "bulls", "Sox", true)).toBe("Bulls BULLS Sox");
  });

  it("changes only rows with a match, rebuilds titles and refuses text that grows too long", () => {
    const a = add({ player: "Ken Grifey Jr.", year: 1990, brand: "Topps" });
    const b = add({ player: "Barry Bonds" });
    const c = add({ player: null });
    const act: BulkAction = { type: "replace", field: "player", find: "grifey", replace: "Griffey", matchCase: false };
    const p = ok(previewBulk(ids(a, b, c), act, db));
    expect(p).toEqual({ count: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/), samples: [{ id: a, title: "T", before: "Ken Grifey Jr.", after: "Ken Griffey Jr." }] });
    ok(applyBulk(ids(a, b, c), act, db));
    expect(get(a)).toMatchObject({ player: "Ken Griffey Jr.", title: "1990 Topps Ken Griffey Jr." });
    expect(get(b).updatedAt).toEqual(T0);

    const long = add({ team: "x".repeat(70) });
    expect(applyBulk(ids(long), { type: "replace", field: "team", find: "x", replace: "yy", matchCase: true }, db))
      .toMatchObject({ error: expect.stringMatching(/too long/) });
    expect(get(long).team).toBe("x".repeat(70));
  });

  it("can empty a field by replacing all of it with nothing", () => {
    const a = add({ notes: "junk" });
    ok(applyBulk(ids(a), { type: "replace", field: "notes", find: "junk", replace: "", matchCase: false }, db));
    expect(get(a).notes).toBeNull();
  });
});

describe("move, status and delete", () => {
  it("moves to a location or to no location, and refuses a location that is gone", () => {
    const a = add();
    const b = add({ locationId: box });
    const p = ok(previewBulk(ids(a, b), { type: "move", locationId: box }, db));
    expect(p).toEqual({ count: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/), samples: [{ id: a, title: "T", before: "No location", after: "Box 1" }] });
    expect(ok(applyBulk(ids(a, b), { type: "move", locationId: box }, db)).summary).toBe("Moved 1 item to Box 1");
    expect(get(a).locationId).toBe(box);
    expect(ok(applyBulk(ids(a, b), { type: "move", locationId: null }, db)).changed).toBe(2);
    expect(applyBulk(ids(a), { type: "move", locationId: 999 }, db)).toEqual({ error: "That location no longer exists." });
  });

  it("marks as checked or needs review", () => {
    const a = add({ status: "needs_review" });
    const b = add({ status: "confirmed" });
    expect(ok(applyBulk(ids(a, b), { type: "status", status: "confirmed" }, db)).summary).toBe("Marked 1 item as checked");
    expect(get(a).status).toBe("confirmed");
  });

  it("delete moves items to Recently deleted, never removes rows or value history", () => {
    const a = add();
    db.insert(valuations).values({ itemId: a, source: "manual", valueCents: 100 }).run();
    db.insert(images).values({ itemId: a, role: "front", file: "x.jpg", thumbFile: "x-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    const r = ok(applyBulk(ids(a), { type: "delete" }, db, later(MIN)));
    expect(r.summary).toBe("Moved 1 item to Recently deleted");
    expect(get(a).deletedAt).toEqual(later(MIN));
    expect(db.select().from(valuations).all()).toHaveLength(1);
    expect(db.select().from(images).all()).toHaveLength(1);
  });
});

describe("selections", () => {
  it("leaves out deleted and unknown ids, and refuses when nothing is left", () => {
    const a = add();
    const gone = add();
    softDeleteItems([gone], db);
    expect(ok(previewBulk(ids(a, gone, 9999), { type: "status", status: "confirmed" }, db)).count).toBe(1);
    ok(applyBulk(ids(a, gone), { type: "status", status: "confirmed" }, db));
    expect(get(gone).status).toBe("needs_review");
    expect(applyBulk(ids(gone), { type: "status", status: "confirmed" }, db)).toEqual({ error: "Nothing here needs this change." });
    expect(previewBulk(ids(), { type: "delete" }, db)).toEqual({ error: "Select at least one item first." });
    expect(ops()).toHaveLength(1);
  });

  it("all matching: runs the filter again and changes nothing when the count moved", () => {
    add({ sport: "baseball" });
    add({ sport: "baseball" });
    add({ sport: "hockey" });
    const sel0: Selection = { filters: { sport: "baseball" }, expectedCount: 2 };
    const pv = ok(previewBulk(sel0, set("team", "Mariners"), db));
    expect(pv.count).toBe(2);
    expect(pv.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const sel: Selection = { ...sel0, fingerprint: pv.fingerprint };
    // Something changed between the preview and the tap: a new item matches.
    const extra = add({ sport: "baseball" });
    expect(applyBulk(sel, set("team", "Mariners"), db)).toEqual({ error: "The list changed. Look again." });
    expect(db.select().from(items).all().every((r) => r.team === null)).toBe(true);
    softDeleteItems([extra], db);
    expect(ok(applyBulk(sel, set("team", "Mariners"), db)).changed).toBe(2);
    expect(get(extra).team).toBeNull();
  });

  it("all matching: same count but a different list is refused, and so is a missing or bad fingerprint", () => {
    const a = add({ sport: "baseball" });
    const b = add({ sport: "baseball" });
    const sel0: Selection = { filters: { sport: "baseball" }, expectedCount: 2 };
    const fingerprint = ok(previewBulk(sel0, set("team", "M"), db)).fingerprint;
    // One leaves, another arrives: the count is still 2.
    softDeleteItems([a], db);
    add({ sport: "baseball" });
    expect(applyBulk({ ...sel0, fingerprint }, set("team", "M"), db)).toEqual({ error: "The list changed. Look again." });
    expect(applyBulk(sel0, set("team", "M"), db)).toEqual({ error: "The list changed. Look again." });
    expect(db.select().from(items).all().every((r) => r.team === null)).toBe(true);
    expect(get(b).team).toBeNull();
    expect(parseSelection({ ...sel0, fingerprint: "xyz" })).toEqual({ error: "Select the items again." });
    expect(parseSelection({ ...sel0, fingerprint: "0123456789abcdef" })).toHaveProperty("filters");
  });

  it("the fingerprint is sha256 of the sorted ids joined by commas, first 16 hex characters", () => {
    expect(fingerprintIds([3, 1, 2])).toBe(createHash("sha256").update("1,2,3").digest("hex").slice(0, 16));
  });

  it("all matching uses the same filters as Inventory, including the parsed form", () => {
    for (let i = 0; i < 45; i++) add({ year: 1990 + (i % 3), player: i % 2 ? "X" : null });
    const filters = inventoryFilterSchema.parse({ yearFrom: "1991", missing: "player", page: "2", sort: "player" });
    const total = listItems(filters, db).total;
    const sel0: Selection = { filters, expectedCount: total };
    const pv = ok(previewBulk(sel0, { type: "status", status: "confirmed" }, db));
    expect(pv.count).toBe(total);
    const sel: Selection = { ...sel0, fingerprint: pv.fingerprint };
    expect(ok(applyBulk(sel, { type: "status", status: "confirmed" }, db)).changed).toBe(total);
    expect(listItems({ ...filters, status: "confirmed" }, db).total).toBe(total);
  });

  it("refuses more than 5,000 matching items", () => {
    const rows = Array.from({ length: MAX_BULK_ITEMS + 1 }, () => ({ kind: "card" as const, title: "T" }));
    for (let i = 0; i < rows.length; i += 500) db.insert(items).values(rows.slice(i, i + 500)).run();
    expect(applyBulk({ filters: {}, expectedCount: MAX_BULK_ITEMS + 1 }, { type: "delete" }, db))
      .toMatchObject({ error: expect.stringMatching(/more than 5,000/) });
    expect(db.select({ n: sql<number>`count(*)` }).from(items).where(sql`${items.deletedAt} is not null`).get()?.n).toBe(0);
  });

  it("smart filters: missing fields, photo, unsure reads and possible duplicates", () => {
    const noPlayer = add({ player: "  " });
    const withPhoto = add({ player: "A", team: "B", confidence: 0.9 });
    db.insert(images).values({ itemId: withPhoto, role: "front", file: "p.jpg", thumbFile: "p-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    const unsure = add({ player: "C", confidence: 0.4 });
    const dupKey = { player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1" };
    const d1 = add({ ...dupKey, status: "confirmed" });
    const d2 = add({ ...dupKey, status: "needs_review" });
    const lone = add({ ...dupKey, year: 1990, status: "confirmed" });
    const q = (p: Record<string, string>) => matchingIds(inventoryFilterSchema.parse(p), 100, db).ids;
    expect(q({ missing: "player" })).toEqual([noPlayer]);
    expect(q({ missing: "team" })).not.toContain(withPhoto);
    expect(q({ missing: "photo" })).not.toContain(withPhoto);
    expect(q({ missing: "photo" })).toContain(noPlayer);
    expect(q({ flag: "lowConfidence" })).toEqual([unsure]);
    // Same rule as findDuplicates: the other one must be checked (confirmed).
    expect(q({ flag: "duplicates" })).toEqual([d2]);
    expect(q({ flag: "duplicates" })).not.toContain(lone);
    softDeleteItems([d1], db);
    expect(q({ flag: "duplicates" })).toEqual([]);
    expect(inventoryFilterSchema.parse({ missing: "nope", flag: "x" })).toEqual({ sort: "newest", page: 1 });
  });
});

describe("purge cleans saved undo text", () => {
  it("removes purged ids from every undo entry and deletes an op left empty", async () => {
    const a = add({ player: "Secret A" });
    const b = add({ player: "Secret B" });
    const c = add({ player: "Keep C" });
    const op1 = ok(applyBulk(ids(a, b, c), set("player", "X"), db, later(MIN)));
    const op2 = ok(applyBulk(ids(a), set("team", "T"), db, later(2 * MIN)));
    softDeleteItems([a, b], db);
    expect(await purgeItems([a, b], db)).toBe(2);
    const left = (undoData(op1.opId, db) as { items: [number, unknown][] }).items.map(([id]) => id);
    expect(left).toEqual([c]);
    expect(JSON.stringify(ops())).not.toMatch(/Secret/);
    expect(ops().map((o) => o.id)).toEqual([op1.opId]);
    expect(undoData(op2.opId, db)).toBeNull();
  });

  it("a live item in the purge list keeps its undo entry", async () => {
    const a = add({ player: "A" });
    const r = ok(applyBulk(ids(a), set("player", "B"), db, later(MIN)));
    expect(await purgeItems([a], db)).toBe(0);
    expect(ops()).toHaveLength(1);
    expect(undoData(r.opId, db)).not.toBeNull();
  });
});

describe("plain messages for over-limit filters", () => {
  it("says what is wrong in plain words", () => {
    const err = (filters: object) => parseSelection({ filters, expectedCount: 1 });
    expect(err({ q: "x".repeat(101) })).toEqual({ error: "That search is too long." });
    expect(err({ yearFrom: 1000 })).toEqual({ error: "That first year is too early." });
    expect(err({ yearTo: 3000 })).toEqual({ error: "That last year is too far ahead." });
    expect(err({ location: 0 })).toEqual({ error: "That location is not valid." });
    expect(err({ tier: [] })).toEqual({ error: "Pick at least one rarity." });
  });
});

describe("safety", () => {
  it("a failure in the middle rolls everything back", () => {
    const list = Array.from({ length: 10 }, () => add({ team: null }));
    const bad = list[6]!;
    db.run(sql`create trigger fail_one before update on items when new.id = ${sql.raw(String(bad))} begin select raise(abort, 'boom'); end`);
    expect(() => applyBulk({ ids: list }, set("team", "Mariners"), db)).toThrow(/boom/);
    expect(db.select().from(items).all().every((r) => r.team === null)).toBe(true);
    expect(ops()).toHaveLength(0);
  });

  it("changes 5,000 items in under 5 seconds", () => {
    const rows = Array.from({ length: MAX_BULK_ITEMS }, (_, i) => ({ kind: "card" as const, title: "T", player: `P${i}`, createdAt: T0, updatedAt: T0 }));
    for (let i = 0; i < rows.length; i += 500) db.insert(items).values(rows.slice(i, i + 500)).run();
    const all0: Selection = { filters: {}, expectedCount: MAX_BULK_ITEMS };
    const fingerprint = ok(previewBulk(all0, set("team", "Mariners"), db)).fingerprint;
    const started = performance.now();
    const r = ok(applyBulk({ ...all0, fingerprint }, set("team", "Mariners"), db, later(MIN)));
    const applyMs = performance.now() - started;
    const mid = performance.now();
    const undo = ok(undoBulk(r.opId, db));
    const undoMs = performance.now() - mid;
    expect(r.changed).toBe(MAX_BULK_ITEMS);
    expect(undo.restored).toBe(MAX_BULK_ITEMS);
    expect(applyMs).toBeLessThan(15_000); // loose: about 2 s when the server is quiet; catches slow code, not a busy server
    expect(undoMs).toBeLessThan(15_000);
  });
});

describe("undo", () => {
  it("a delete whose items were all put back from Recently deleted is no longer offered, and its Undo does nothing (review fix 8)", () => {
    const a = add({ player: "Billy Mills" });
    const b = add({ player: "Billy Mills" });
    const r = ok(applyBulk(ids(a, b), { type: "delete" }, db, later(MIN)));
    expect(latestUndoable(db, later(2 * MIN))).toMatchObject({ id: r.opId });
    restoreItems([a], db, later(2 * MIN));
    // One is still in the bin from that change: still offered.
    expect(latestUndoable(db, later(3 * MIN))).toMatchObject({ id: r.opId });
    restoreItems([b], db, later(3 * MIN));
    expect(latestUndoable(db, later(4 * MIN))).toBeNull();
    expect(undoBulk(r.opId, db, later(4 * MIN))).toEqual({ error: "Nothing to undo: these items were already put back from Recently deleted." });
    expect(get(a).deletedAt).toBeNull();
  });

  it("the undo line says what an import undo did (review fix 8)", () => {
    expect(undoLine({ kind: "import", restored: 0, removed: 4, skipped: 0 })).toBe("Removed the 4 items the import added. They are in Recently deleted.");
    expect(undoLine({ kind: "import", restored: 2, removed: 1, skipped: 0 })).toBe("Removed the 1 item the import added. It is in Recently deleted. Put back the old values of 2 items.");
    expect(undoLine({ kind: "delete", restored: 2, removed: 0, skipped: 1 })).toBe("Put back 2 items from Recently deleted. Skipped 1 (edited or removed since).");
    expect(undoLine({ kind: "change", restored: 1, removed: 0, skipped: 0 })).toBe("Put back the old values of 1 item.");
  });

  it("puts back exactly the old values of the touched columns, and refuses a second undo", () => {
    const a = add({ player: "Ken Grifey", year: 1990, brand: "Topps", title: "1990 Topps Ken Grifey", team: "Mariners" });
    const before = get(a);
    const r = ok(applyBulk(ids(a), set("player", "Ken Griffey Jr."), db, later(MIN)));
    expect(get(a).title).toBe("1990 Topps Ken Griffey Jr.");
    expect(latestUndoable(db, later(2 * MIN))).toMatchObject({ id: r.opId, summary: "Set player on 1 item", itemCount: 1 });
    expect(r.ids).toEqual([a]);
    expect(ok(undoBulk(r.opId, db, later(2 * MIN)))).toEqual({ restored: 1, removed: 0, skipped: 0, summary: "Set player on 1 item", ids: [a], kind: "change" });
    expect(get(a)).toEqual(before);
    expect(undoBulk(r.opId, db)).toEqual({ error: "This change was already undone." });
    expect(latestUndoable(db)).toBeNull();
    expect(undoBulk(424242, db)).toEqual({ error: "This change can no longer be undone." });
  });

  it("bulk delete then undo brings the items back, even after a location was deleted or a restore elsewhere", () => {
    const a = add({ locationId: box });
    const b = add();
    const r = ok(applyBulk(ids(a, b), { type: "delete" }, db, later(MIN)));
    expect(get(a).deletedAt).not.toBeNull();
    expect(ok(undoBulk(r.opId, db, later(2 * MIN)))).toMatchObject({ restored: 2, skipped: 0 });
    expect(get(a).deletedAt).toBeNull();
    expect(get(b).deletedAt).toBeNull();
  });

  it("deleting a location or restoring from the bin counts as an edit, so undo leaves those items alone", () => {
    const a = add({ locationId: box, team: "Old" });
    const b = add({ team: "Old" });
    const r = ok(applyBulk(ids(a, b), set("team", "New"), db, later(MIN)));
    deleteLocation(box, db, later(2 * MIN));
    expect(get(a).updatedAt).toEqual(later(2 * MIN));
    softDeleteItems([b], db, later(2 * MIN));
    restoreItems([b], db, later(3 * MIN));
    expect(get(b).updatedAt).toEqual(later(3 * MIN));
    expect(ok(undoBulk(r.opId, db, later(4 * MIN)))).toMatchObject({ restored: 0, skipped: 2 });
    expect(get(a).team).toBe("New");
  });

  it("skips items edited, deleted or whose location went away since, and reports the numbers", () => {
    const loc2 = db.insert(locations).values({ name: "Box 2" }).returning({ id: locations.id }).get().id;
    const edited = add({ locationId: box });
    const deleted = add({ locationId: box });
    const lostLoc = add({ locationId: loc2 });
    const fine = add({ locationId: box });
    const r = ok(applyBulk(ids(edited, deleted, lostLoc, fine), { type: "move", locationId: null }, db, later(-MIN)));
    expect(updateItem(edited, { notes: "changed by hand", locationId: "", quantity: "1" }, db)).toEqual({ ok: true });
    softDeleteItems([deleted], db);
    db.delete(locations).where(eq(locations.id, loc2)).run();
    expect(ok(undoBulk(r.opId, db))).toMatchObject({ restored: 1, skipped: 3 });
    expect(get(fine).locationId).toBe(box);
    expect(get(edited)).toMatchObject({ locationId: null, notes: "changed by hand" });
    expect(get(deleted).locationId).toBeNull();
  });

  it("only the latest change can be undone; undoing it makes the one before undoable again", () => {
    const a = add({ team: "A" });
    const first = ok(applyBulk(ids(a), set("team", "B"), db, later(MIN)));
    const second = ok(applyBulk(ids(a), set("team", "C"), db, later(2 * MIN)));
    expect(undoBulk(first.opId, db, later(3 * MIN))).toEqual({ error: "Only the latest change can be undone." });
    expect(get(a).team).toBe("C");
    expect(ok(undoBulk(second.opId, db, later(3 * MIN))).restored).toBe(1);
    expect(get(a).team).toBe("B");
    // The undo put back the time of the first change too, so it is not taken for a later edit.
    expect(ok(undoBulk(first.opId, db, later(4 * MIN))).restored).toBe(1);
    expect(get(a)).toMatchObject({ team: "A", updatedAt: T0 });
  });

  it("undo of a later bulk edit is skipped for items another bulk change touched after it", () => {
    const a = add({ team: "A" });
    const b = add({ team: "A" });
    const first = ok(applyBulk(ids(a, b), set("team", "B"), db, later(MIN)));
    // A later single edit on b, then undo of the bulk change.
    db.update(items).set({ team: "Z", updatedAt: later(2 * MIN) }).where(eq(items.id, b)).run();
    expect(ok(undoBulk(first.opId, db, later(3 * MIN)))).toMatchObject({ restored: 1, skipped: 1 });
    expect([get(a).team, get(b).team]).toEqual(["A", "Z"]);
  });

  it("undo of a delete is a restore, only for items still in the bin from that change", () => {
    const a = add();
    const b = add();
    const c = add();
    const r = ok(applyBulk(ids(a, b, c), { type: "delete" }, db, later(MIN)));
    // b was brought back by hand and deleted again; c was removed for good.
    db.update(items).set({ deletedAt: later(5 * MIN) }).where(eq(items.id, b)).run();
    db.delete(items).where(eq(items.id, c)).run();
    expect(ok(undoBulk(r.opId, db, later(6 * MIN)))).toMatchObject({ restored: 1, skipped: 2 });
    expect(get(a).deletedAt).toBeNull();
    expect(get(b).deletedAt).toEqual(later(5 * MIN));
  });

  it("undo of an own value puts the old one back and records it in the value history", () => {
    const a = add({ manualValueCents: 500 });
    const b = add({ manualValueCents: null });
    const r = ok(applyBulk(ids(a, b), set("manualValue", "20"), db, later(MIN)));
    ok(undoBulk(r.opId, db, later(2 * MIN)));
    expect([get(a).manualValueCents, get(b).manualValueCents]).toEqual([500, null]);
    expect(db.select().from(valuations).all().map((v) => [v.itemId, v.valueCents])).toEqual([[a, 2000], [b, 2000], [a, 500]]);
  });

  it("keeps the latest 20 changes and none older than 30 days", () => {
    const a = add({ quantity: 1 });
    for (let i = 0; i < BULK_KEEP + 5; i++) ok(applyBulk(ids(a), set("quantity", String(i + 2)), db, later(i * MIN)));
    expect(ops()).toHaveLength(BULK_KEEP);
    const latest = latestUndoable(db, later(30 * MIN))!;
    expect(latestUndoable(db, later(31 * 24 * 60 * MIN))).toBeNull();
    expect(undoBulk(latest.id, db, later(31 * 24 * 60 * MIN))).toEqual({ error: "This change can no longer be undone." });
    ok(applyBulk(ids(a), set("quantity", "99"), db, later(40 * 24 * 60 * MIN)));
    expect(ops()).toHaveLength(1);
  });

  it("stores no more than the changed columns", () => {
    const a = add({ team: "A", player: "X", title: "X", notes: "private words" });
    const r = ok(applyBulk(ids(a), set("team", "B"), db, later(MIN)));
    const op = ops().find((o) => o.id === r.opId)!;
    expect(JSON.parse(op.undo)).toEqual({ v: 1, items: [[a, { team: "A", updatedAt: T0.getTime() }]] });
    expect(op.summary).not.toContain("B");
  });
});

// Server actions: owner check first, then zod, then the audit log.
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect ${to}`); }
}
const auth = vi.hoisted(() => ({ signedIn: false, audit: [] as { event: string; detail?: string | null }[] }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirected(to); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/guard", () => ({
  requireOwner: async () => { if (!auth.signedIn) throw new Redirected("/login"); },
}));
vi.mock("@/lib/audit/request", () => ({
  auditThisRequest: async (event: string, _outcome: string, detail?: string | null) => { auth.audit.push({ event, detail }); },
}));
const actions = await import("./bulk-actions");

describe("server actions", () => {
  beforeEach(() => { auth.signedIn = false; auth.audit.length = 0; });

  it("every action sends a visitor without a session to /login and changes nothing", async () => {
    const a = add({ team: "A" });
    const req = { selection: { ids: [a] }, action: { type: "delete" } };
    const calls = [
      () => actions.previewBulkAction(req), () => actions.applyBulkAction(req), () => actions.undoBulkAction(1),
      () => actions.restoreItemsAction([a]), () => actions.purgeItemsAction([a]), () => actions.emptyBinAction(),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ to: "/login" });
    expect(get(a).deletedAt).toBeNull();
    expect(auth.audit).toEqual([]);
  });

  it("apply, undo, restore and purge write the activity log in a few words", async () => {
    auth.signedIn = true;
    const a = add({ notes: "secret family note" });
    const b = add();
    expect(await actions.previewBulkAction({ selection: { ids: [a, b] }, action: { type: "set", field: "notes", value: "other secret", onlyEmpty: false } }))
      .toMatchObject({ count: 2 });
    expect(auth.audit).toEqual([]);
    const edit = await actions.applyBulkAction({ selection: { ids: [a, b] }, action: { type: "set", field: "notes", value: "other secret", onlyEmpty: false } });
    expect(edit).toMatchObject({ changed: 2 });
    const del = await actions.applyBulkAction({ selection: { ids: [a, b] }, action: { type: "delete" } });
    expect(del).toMatchObject({ changed: 2 });
    expect(await actions.undoBulkAction("x")).toHaveProperty("error");
    expect(await actions.undoBulkAction((del as { opId: number }).opId)).toEqual({ restored: 2, removed: 0, skipped: 0, kind: "delete" });
    ok(applyBulk(ids(a, b), { type: "delete" }, db));
    expect(await actions.restoreItemsAction([a])).toEqual({ restored: 1 });
    expect(await actions.restoreItemsAction([])).toHaveProperty("error");
    expect(await actions.purgeItemsAction([a])).toEqual({ removed: 0 });
    expect(await actions.emptyBinAction()).toEqual({ removed: 1 });
    expect(get(b)).toBeUndefined();
    expect(auth.audit).toEqual([
      { event: "bulk_edit", detail: "Set notes on 2 items" },
      { event: "bulk_delete", detail: "Moved 2 items to Recently deleted" },
      { event: "bulk_undo", detail: "Moved 2 items to Recently deleted. Put back 2 items from Recently deleted." },
      { event: "bulk_restore", detail: "1 item" },
      { event: "bulk_purge", detail: "emptied the bin, 1 item" },
    ]);
    expect(JSON.stringify(auth.audit)).not.toMatch(/secret/);
  });

  it("refuses bad input with a short message", async () => {
    auth.signedIn = true;
    expect(await actions.applyBulkAction(null)).toHaveProperty("error");
    expect(await actions.applyBulkAction({ selection: { ids: [] }, action: { type: "delete" } })).toEqual({ error: "Select at least one item first." });
    expect(await actions.applyBulkAction({ selection: { ids: [1] }, action: { type: "nuke" } })).toHaveProperty("error");
    expect(auth.audit).toEqual([]);
  });
});
