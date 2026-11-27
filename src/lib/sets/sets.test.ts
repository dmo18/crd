import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { cardSets, checklistEntries, items, outsideUsage, wantedCards, type NewItem } from "@/db/schema";
import { createMyCardfolio, parseChecklist, parseSearch } from "@/lib/catalog/mycardfolio";
import type { Catalog, CatalogCard, CatalogResult } from "@/lib/catalog/types";
import { loadChecklist, looksComplete, setIdFrom } from "./checklist";
import { compareNumbers, keyOfFields, numberKeyOf, parseSetKey, setIdentityOf, setKeyOf, setLabel } from "./identity";
import { missingCsv, missingText } from "./missing";
import { copiesLine, listOwnedSets, ownedLine, setBreakdown, setView } from "./view";

/** Recorded answers only: tests never reach the network (docs/CATALOG-TRIAL.md, "Checklist probe"). */
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8"));
const sse = (name: string) => `event: message\ndata: ${JSON.stringify(fixture(name).response)}\n\n`;
const CHECKLIST = parseChecklist(sse("checklist_9179_first500.json"), "9179")!;
const SEARCH_650 = parseSearch(sse("search_1990_topps_650.json"))!;

const KEY = "1990_topps__baseball";
let db: Db;
const add = (over: Partial<NewItem>) =>
  db.insert(items).values({ kind: "card", status: "confirmed", title: "Card", sport: "baseball", year: 1990, brand: "Topps", ...over }).returning({ id: items.id }).get().id;

/** A fake catalog that replays recorded answers and counts what was asked. */
function replay(opts: { search?: CatalogResult<CatalogCard[]>; checklist?: CatalogResult<{ cards: CatalogCard[]; complete: boolean; total?: number | null }> } = {}) {
  const asked = { search: [] as string[], checklist: [] as string[] };
  const catalog: Catalog = {
    async search(q) { asked.search.push(q.text); return opts.search ?? { ok: true, value: SEARCH_650, fromStore: false }; },
    async card() { return { ok: true, value: null, fromStore: false }; },
    async checklist(id) { asked.checklist.push(id); return opts.checklist ?? { ok: true, value: CHECKLIST, fromStore: false }; },
  };
  return { catalog, asked };
}

beforeEach(() => {
  db = createDb(":memory:");
});

describe("set identity", () => {
  it("year, brand, set name and sport, case and accents ignored; a set name that repeats the brand is the base set", () => {
    const a = keyOfFields({ sport: "baseball", year: 1990, brand: "Topps", setName: null });
    expect(a).toBe(KEY);
    expect(keyOfFields({ sport: "baseball", year: 1990, brand: " TOPPS ", setName: "Topps" })).toBe(KEY);
    expect(keyOfFields({ sport: "baseball", year: 1990, brand: "topps", setName: "Base Set" })).toBe(KEY);
    expect(keyOfFields({ sport: "hockey", year: 1991, brand: "O-Pee-Chée", setName: "Prémier" })).toBe("1991_o-pee-chee_premier_hockey");
    expect(keyOfFields({ sport: "football", year: 1990, brand: "Topps", setName: null })).not.toBe(KEY);
    expect(keyOfFields({ sport: "baseball", year: null, brand: "Topps", setName: null })).toBeNull();
    expect(keyOfFields({ sport: "baseball", year: 1990, brand: null, setName: null })).toBeNull();
    expect(keyOfFields({ sport: null, year: 1990, brand: null, setName: "Topps" })).toBe("1990_topps__");
  });
  it("a key reads back, and anything else is refused", () => {
    const id = setIdentityOf({ sport: "baseball", year: 1991, brand: "Upper Deck", setName: "SP" })!;
    expect(parseSetKey(setKeyOf(id))).toEqual(id);
    for (const bad of ["1990_topps__golfball", "1990_Topps__baseball", "../x", "1990_topps_baseball", "1990_-topps__baseball", "1990_topps--x__"]) {
      expect(parseSetKey(bad), bad).toBeNull();
    }
  });
  it("labels and numbers", () => {
    expect(setLabel({ sport: "baseball", year: 1990, brand: "Topps", setName: "Topps" })).toBe("1990 Topps, Baseball");
    expect(setLabel({ sport: null, year: 1991, brand: "Upper Deck", setName: "SP" })).toBe("1991 Upper Deck SP");
    expect(numberKeyOf("#0336")).toBe("336");
    expect(numberKeyOf("  ")).toBeNull();
    expect(["10", "2", "U1", "1", "10A", null, "100"].sort(compareNumbers)).toEqual(["1", "2", "10", "10A", "100", "U1", null]);
  });
});

describe("the Sets list (no outside call)", () => {
  it("lists the owner's sets with distinct owned cards; sold, removed and deleted items do not count", () => {
    add({ cardNumber: "336", player: "Ken Griffey Jr." });
    add({ cardNumber: "336", player: "Ken Griffey Jr.", status: "needs_review" });
    add({ cardNumber: "1", player: "Nolan Ryan" });
    add({ cardNumber: "414", player: "Frank Thomas", status: "sold" });
    add({ cardNumber: "5", player: "Gone", status: "removed" });
    add({ cardNumber: "6", player: "Bin", deletedAt: new Date() });
    add({ year: 1992, brand: "Donruss", setName: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    add({ kind: "sealed", title: "Box", cardNumber: null });
    const sets = listOwnedSets(db);
    expect(sets.map((s) => [s.key, s.title, s.owned, s.inReview, s.percent])).toEqual([
      [KEY, "1990 Topps", 2, 1, null],
      ["1992_donruss__baseball", "1992 Donruss", 1, 0, null],
    ]);
    expect(setBreakdown(10, db).map((s) => [s.label, s.units])).toEqual([["1990 Topps, Baseball", 3], ["1992 Donruss, Baseball", 1]]);
  });
});

describe("owned wording adds up (review 7)", () => {
  it("in Review is a part of the owned count, copies are copies", () => {
    expect(ownedLine(1, 1)).toBe("1 card owned (in Review)");
    expect(ownedLine(3, 1)).toBe("3 cards owned (1 in Review)");
    expect(ownedLine(2, 0)).toBe("2 cards owned");
    expect(copiesLine(3)).toBe("3 copies");
    expect(copiesLine(1)).toBeNull();
  });

  it("one card in three items and a quantity: 1 card owned, 4 copies; Review counts distinct cards", () => {
    add({ cardNumber: "336", player: "Ken Griffey Jr.", status: "needs_review" });
    add({ cardNumber: "336", player: "Ken Griffey Jr.", status: "needs_review" });
    add({ cardNumber: "336", player: "Ken Griffey Jr.", status: "needs_review", quantity: 2 });
    const [s] = listOwnedSets(db);
    expect(ownedLine(s.owned, s.inReview)).toBe("1 card owned (in Review)");
    const v = setView(KEY, db)!;
    expect(ownedLine(v.counts.owned, v.counts.inReview)).toBe("1 card owned (in Review)");
    expect(copiesLine(v.rows[0].items.reduce((n, i) => n + i.quantity, 0))).toBe("4 copies");
  });
});

describe("a set page", () => {
  it("without a checklist: owned cards in number order, copies once, blank numbers apart, no percent", () => {
    add({ cardNumber: "336", player: "Ken Griffey Jr." });
    const review = add({ cardNumber: "336", player: "Ken Griffey Jr.", status: "needs_review" });
    add({ cardNumber: "10", player: "Gregg Olson" });
    add({ cardNumber: null, player: "Bo Jackson" });
    const v = setView(KEY, db)!;
    expect(v.rows.map((r) => [r.cardNumber, r.owned, r.items.length])).toEqual([["10", true, 1], ["336", true, 2]]);
    expect(v.rows[1].items.find((i) => i.id === review)?.inReview).toBe(true);
    expect(v.noNumber.map((c) => c.player)).toEqual(["Bo Jackson"]);
    expect(v.counts).toMatchObject({ owned: 3, missing: 0, inReview: 1 });
    expect(v.checklist).toBeNull();
    expect(v.percent).toBeNull();
    expect(setView("1999_nothing__baseball", db)).toBeNull();
    expect(setView("bad key", db)).toBeNull();
  });

  it("Get the checklist: finds the set id with one search, stores 500 entries, partial, no percent", async () => {
    add({ cardNumber: "650", player: "Mike Witt" });
    add({ cardNumber: "336", player: "Ken Griffey Jr." });
    add({ cardNumber: "336", player: "Ken Griffey Jr." });
    add({ cardNumber: "2", player: "Jose Canseco" });
    const { catalog, asked } = replay();
    const r = await loadChecklist(KEY, { db, catalog });
    expect(r).toEqual({ kind: "loaded", entries: 500, complete: false });
    expect(asked.search).toHaveLength(1);
    expect(asked.search[0]).toMatch(/^1990 Topps \d+ /);
    expect(asked.checklist).toEqual(["9179"]);
    const set = db.select().from(cardSets).where(eq(cardSets.key, KEY)).get()!;
    expect(set).toMatchObject({ sourceSetId: "9179", checklistComplete: false, checklistTotal: 792, lastStop: null });

    const v = setView(KEY, db)!;
    expect(v.checklist).toMatchObject({ present: true, complete: false, total: 792, listed: 500 });
    expect(v.percent).toBeNull();
    expect(v.counts).toMatchObject({ owned: 3, ownedOnList: 2, missing: 498 });
    const r336 = v.rows.find((r) => r.numberKey === "336")!;
    expect(r336).toMatchObject({ owned: true, onList: true, listSays: null });
    expect(r336.items).toHaveLength(2);
    // The player is the check: number 2 on the list is another card.
    expect(v.rows.find((r) => r.numberKey === "2")).toMatchObject({ owned: true, listSays: "Nolan Ryan Salute-New York Mets" });
    // 650 is past the first 500 the catalog sends: owned, not on the list.
    expect(v.rows.find((r) => r.numberKey === "650")).toMatchObject({ owned: true, onList: false });
    expect(v.rows.find((r) => r.numberKey === "1")).toMatchObject({ owned: false, player: "Nolan Ryan" });

    // Offline afterwards: the page reads only the database.
    const text = missingText(v);
    expect(text.split("\n").slice(0, 3)).toEqual(["1990 Topps, Baseball: 498 missing cards", "This checklist may be incomplete.", "#1 Nolan Ryan"]);
  });

  it("a set id already known from a linked or kept candidate needs no search", async () => {
    const card = CHECKLIST.cards.find((c) => c.cardNumber === "336")!;
    const { serializeCatalog } = await import("@/lib/catalog/candidates");
    add({ cardNumber: "336", player: "Ken Griffey Jr.", catalogCandidates: serializeCatalog({ status: "candidates", items: [card] }, new Date()) });
    const { catalog, asked } = replay();
    expect(await loadChecklist(KEY, { db, catalog })).toMatchObject({ kind: "loaded" });
    expect(asked.search).toEqual([]);
    expect(asked.checklist).toEqual(["9179"]);
  });

  it("want marks: only on missing cards from the stored list, survive Get it again, go when the card is owned", async () => {
    add({ cardNumber: "336", player: "Ken Griffey Jr." });
    const { catalog } = replay();
    await loadChecklist(KEY, { db, catalog });
    const set = db.select().from(cardSets).get()!;
    db.insert(wantedCards).values({ setId: set.id, numberKey: "1", cardNumber: "1", player: "Nolan Ryan" }).run();
    db.insert(wantedCards).values({ setId: set.id, numberKey: "100", cardNumber: "100", player: "Mike Smithson" }).run();
    expect(setView(KEY, db)!.counts.wanted).toBe(2);

    await loadChecklist(KEY, { db, catalog }); // Get it again
    expect(db.select().from(checklistEntries).all()).toHaveLength(500);
    const v = setView(KEY, db)!;
    expect(v.rows.filter((r) => r.wanted).map((r) => r.numberKey)).toEqual(["1", "100"]);
    expect(missingCsv(v).split("\r\n").slice(0, 3)).toEqual([
      "﻿Set,Card number,Player,Team,Wanted,Status", "\"1990 Topps, Baseball\",1,Nolan Ryan,,Yes,Missing", "\"1990 Topps, Baseball\",2,Nolan Ryan Salute-New York Mets,,No,Missing",
    ]);

    // The owner scans number 1: owned, the mark goes.
    add({ cardNumber: "#001", player: "Nolan Ryan", status: "needs_review" });
    const after = setView(KEY, db)!;
    expect(after.rows.find((r) => r.numberKey === "1")).toMatchObject({ owned: true, wanted: false });
    expect(db.select().from(wantedCards).all().map((w) => w.numberKey)).toEqual(["100"]);
  });

  it("the catalog does not have the set: said plainly, nothing made up", async () => {
    add({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    const { catalog, asked } = replay({ search: { ok: true, value: [], fromStore: false } });
    expect(await loadChecklist("1992_donruss__baseball", { db, catalog })).toEqual({ kind: "not_in_catalog" });
    expect(asked.checklist).toEqual([]);
    const v = setView("1992_donruss__baseball", db)!;
    expect(v.set?.notInCatalogAt).toBeInstanceOf(Date);
    expect(v.checklist).toBeNull();
    expect(v.rows.map((r) => [r.cardNumber, r.owned])).toEqual([["101", true]]);
  });

  it("a set the owner has no cards of is never loaded", async () => {
    const { catalog, asked } = replay();
    expect(await loadChecklist(KEY, { db, catalog })).toEqual({ kind: "no_set" });
    expect(asked).toEqual({ search: [], checklist: [] });
  });

  it("the daily limit pauses the load through the real gate; the next tap goes on from there", async () => {
    add({ cardNumber: "650", player: "Mike Witt" });
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const tool = JSON.parse(String(init?.body)).params.name;
      return new Response(sse(tool === "search_cards" ? "search_1990_topps_650.json" : "checklist_9179_first500.json"), { status: 200 });
    });
    const catalog = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
    const day = new Date().toISOString().slice(0, 10);
    db.insert(outsideUsage).values({ source: "mycardfolio", day, calls: 1000 }).run();
    expect(await loadChecklist(KEY, { db, catalog })).toEqual({ kind: "stopped", reason: "cap", step: "find" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.select().from(cardSets).get()).toMatchObject({ lastStop: "cap", sourceSetId: null });

    // The limit is over (a new day): the search, then the list.
    db.update(outsideUsage).set({ calls: 0 }).run();
    expect(await loadChecklist(KEY, { db, catalog })).toMatchObject({ kind: "loaded", entries: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Get it again: the stored answer (30 days) is used, no new call.
    expect(await loadChecklist(KEY, { db, catalog })).toMatchObject({ kind: "loaded", entries: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("a stop at the list keeps the set id: the next tap asks only for the list", async () => {
    add({ cardNumber: "650", player: "Mike Witt" });
    const first = replay({ checklist: { ok: false, reason: "cap" } });
    expect(await loadChecklist(KEY, { db, catalog: first.catalog })).toEqual({ kind: "stopped", reason: "cap", step: "list" });
    const again = replay();
    expect(await loadChecklist(KEY, { db, catalog: again.catalog })).toMatchObject({ kind: "loaded" });
    expect(again.asked).toEqual({ search: [], checklist: ["9179"] });
  });

  it("a complete checklist shows the percent; it is cleared after 30 days but wants stay", async () => {
    const cards = CHECKLIST.cards.slice(0, 4);
    add({ cardNumber: "1", player: "Nolan Ryan" });
    const { catalog } = replay({ checklist: { ok: true, value: { cards, complete: true, total: 4 }, fromStore: false } });
    const t0 = new Date("2026-11-01T00:00:00Z");
    expect(await loadChecklist(KEY, { db, catalog, now: t0 })).toEqual({ kind: "loaded", entries: 4, complete: true });
    const v = setView(KEY, db, { now: t0 })!;
    expect(v.percent).toBe(25);
    expect(v.counts).toMatchObject({ ownedOnList: 1, missing: 3 });
    const set = db.select().from(cardSets).get()!;
    db.insert(wantedCards).values({ setId: set.id, numberKey: "2", cardNumber: "2", player: "x" }).run();

    const later = setView(KEY, db, { now: new Date("2026-12-05T00:00:00Z") })!;
    expect(later.checklist).toMatchObject({ present: false, expired: true });
    expect(later.percent).toBeNull();
    expect(db.select().from(checklistEntries).all()).toHaveLength(0);
    expect(later.rows.filter((r) => r.wanted).map((r) => r.numberKey)).toEqual(["2"]);
  });
});

describe("rules", () => {
  it("complete only when the source says so and no number up to the highest is missing", () => {
    const e = (...n: string[]) => n.map((numberKey) => ({ numberKey }));
    expect(looksComplete(e("1", "2", "3"), true, 3)).toBe(true);
    expect(looksComplete(e("1", "2", "4"), true, null)).toBe(false);
    expect(looksComplete(e("1", "2", "3"), false, 3)).toBe(false);
    expect(looksComplete(e("1", "2", "3"), true, 5)).toBe(false);
  });
  it("the set id is the base set's, never a version's or another year's", () => {
    const id = setIdentityOf({ sport: "baseball", year: 1990, brand: "Topps", setName: null })!;
    const spelling = { sport: "baseball" as const, year: 1990, brand: "Topps", setName: null };
    expect(setIdFrom(id, spelling, SEARCH_650)).toBe("9179");
    const tiffanyOnly = SEARCH_650.filter((c) => c.variation);
    expect(tiffanyOnly.length).toBeGreaterThan(0);
    expect(setIdFrom(id, spelling, tiffanyOnly)).toBeNull();
    expect(setIdFrom({ ...id, year: 1991 }, { ...spelling, year: 1991 }, SEARCH_650)).toBeNull();
  });
  it("CSV cells starting with a formula sign are guarded", () => {
    add({ cardNumber: "1", player: "x" });
    const v = setView(KEY, db)!;
    v.rows = [{ numberKey: "2", cardNumber: "2", player: "=HYPERLINK(1)", team: "+x", url: null, owned: false, wanted: false, items: [], onList: true, listSays: null }];
    expect(missingCsv(v).split("\r\n")[1]).toBe("\"1990 Topps, Baseball\",2,'=HYPERLINK(1),'+x,No,Missing");
  });
});
