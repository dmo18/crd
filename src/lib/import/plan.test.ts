import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { bulkOps, images, items, locations, valuations, type Item, type NewItem } from "@/db/schema";
import { itemsToCsv } from "@/lib/export/csv";
import { latestUndoable, undoBulk } from "@/lib/items/bulk";
import { purgeItems } from "@/lib/items/bin";
import { parseCsv } from "./csv";
import { guessMapping, SKIP, type ColumnChoice } from "./fields";
import { applyImport, setImportHooksForTests, checkMapping, duplicateKey, previewImport, type ImportOptions } from "./plan";

let db: Db;
const T0 = new Date("2026-11-01T12:00:00Z");
const NOW = new Date("2026-11-20T12:00:00Z");
const LATER = new Date("2026-11-21T12:00:00Z");
const OPTS: ImportOptions = { unknownSportOther: false, duplicates: "skip" };

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
});
afterEach(() => setDbForTests(undefined));

const add = (over: Partial<NewItem> = {}) =>
  db.insert(items).values({ kind: "card", title: "T", status: "confirmed", createdAt: T0, updatedAt: T0, ...over }).returning({ id: items.id }).get().id;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get() as Item;
const all = () => db.select().from(items).all();
const ok = <T extends object>(r: T | { error: string }): T => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};
/** The guessed mapping of a file. */
const guess = (text: string): ColumnChoice[] => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(r.error);
  return guessMapping(r.header);
};
const check = (text: string, opts = OPTS) => previewImport(text, guess(text), opts, db, NOW);
const run = (text: string, opts = OPTS, skipProblems = false) => applyImport(text, guess(text), opts, { skipProblems }, db, NOW);

describe("checking the column choices", () => {
  it("refuses a field chosen twice, nothing chosen, and a wrong width", () => {
    expect(checkMapping(["player", "player"], 2)).toEqual({ error: 'Two columns are set to "Player". Choose it for one column only.' });
    expect(checkMapping([SKIP, SKIP], 2)).toHaveProperty("error");
    expect(checkMapping(["id"], 1)).toHaveProperty("error");
    expect(checkMapping(["player"], 2)).toHaveProperty("error");
    expect(checkMapping(["title"], 1)).toHaveProperty("error");
    expect(checkMapping(["player", SKIP], 2)).toEqual(["player", SKIP]);
  });
});

describe("row problems", () => {
  it("reports each problem by row and column in plain words, and saves nothing until asked", () => {
    const text = [
      "Player,Year,Sport,Rookie,Value,Brand",
      "Ken Griffey Jr.,1989,Baseball,Yes,$1.50,Upper Deck",
      "Frank Thomas,1850,Baseball,No,,Topps",
      "Bo Jackson,1990,Cricket,maybe,ten dollars,Score",
      ",1991,Baseball,,,Fleer",
      `Long Name,1991,,,,${"B".repeat(81)}`,
    ].join("\n");
    const p = ok(check(text));
    expect(p.counts).toMatchObject({ rows: 5, added: 1, problems: 4 });
    const top = NOW.getUTCFullYear() + 1;
    expect(p.problems.map((x) => x.message)).toEqual([
      `Row 3: Year must be a number between 1860 and ${top}.`,
      'Row 4: Sport "Cricket" is not one the app knows. Fix it, or tick "Unknown sports become Other".',
      "Row 4: Rookie must be yes or no (also Y, N, true, false, x).",
      "Row 4: Value must be a dollar amount like 12.50 or $1,234.50.",
      "Row 5: Fill in at least a player, a set or a description so you can find this again.",
      "Row 6: Brand: Keep this under 80 characters.",
    ]);
    expect(run(text)).toEqual({ error: "4 rows have problems. Fix them, or choose to skip them." });
    expect(all()).toHaveLength(0);
    const r = ok(run(text, OPTS, true));
    expect(r).toMatchObject({ added: 1, updated: 0, skipped: 4 });
    expect(all().map((i) => i.player)).toEqual(["Ken Griffey Jr."]);
  });

  it("a cell that looks like a spreadsheet formula is a row problem, skipped by default; the export's guarded cell is not (review fix 13)", () => {
    const text = "Player,Year,Brand\n=1+1,1989,Upper Deck\n'=Plus One,1990,Topps\nKen Griffey Jr.,1989,Upper Deck\n";
    const p = ok(check(text));
    expect(p.problems.map((x) => x.message)).toEqual(["Row 2: Player looks like a spreadsheet formula (=1+1). Type the value itself, or leave the row out."]);
    expect(run(text)).toHaveProperty("error");
    ok(run(text, OPTS, true));
    expect(all().map((i) => i.player).sort()).toEqual(["=Plus One", "Ken Griffey Jr."]);
  });

  it("refuses a year after next year", () => {
    const p = ok(check(`Player,Year\nA,${NOW.getUTCFullYear() + 2}\nB,${NOW.getUTCFullYear() + 1}\nC,1993-94`));
    expect(p.counts).toMatchObject({ added: 2, problems: 1 });
  });

  it("turns unknown sports into Other only when the owner ticks it", () => {
    const text = "Player,Sport\nA,Cricket\nB,HOCKEY";
    expect(ok(check(text)).counts.problems).toBe(1);
    ok(run(text, { ...OPTS, unknownSportOther: true }));
    expect(all().map((i) => i.sport)).toEqual(["other", "hockey"]);
  });
});

describe("new items", () => {
  it("are saved like Add by hand: checked, title built, the owner's fields and value", () => {
    const r = ok(run("Player,Year,Brand,Card #,Condition,Value,Qty,Box,Notes\nKen Griffey Jr.,1989,Upper Deck,1,NM,\"$1,234.50\",2,Box 7,'=1+1\n"));
    expect(r.added).toBe(1);
    const item = all()[0];
    expect(item).toMatchObject({
      status: "confirmed", title: "1989 Upper Deck #1 Ken Griffey Jr.", condition: "near_mint", manualValueCents: 123450,
      quantity: 2, notes: "=1+1", createdAt: NOW,
    });
    expect(JSON.parse(item.fieldSources!)).toEqual({ player: "owner", year: "owner", brand: "owner", cardNumber: "owner" });
    const place = db.select().from(locations).all();
    expect(place.map((l) => l.name)).toEqual(["Box 7"]);
    expect(item.locationId).toBe(place[0].id);
    expect(db.select().from(valuations).all()).toMatchObject([{ itemId: item.id, source: "manual", valueCents: 123450 }]);
    // The formula text is kept as text, and made safe again on export.
    expect(itemsToCsv([item], new Map())).toContain(",'=1+1,");
  });

  it("finds a location by name with any capitals", () => {
    const box = db.insert(locations).values({ name: "Box 7" }).returning({ id: locations.id }).get().id;
    const p = ok(check("Player,Location\nA,box 7"));
    expect(p.newLocations).toEqual([]);
    ok(run("Player,Location\nA,box 7"));
    expect(all()[0].locationId).toBe(box);
  });
});

describe("updates by ID", () => {
  it("changes only the mapped columns and leaves photos and everything else alone", () => {
    const id = add({
      player: "Ken Griffey", year: 1989, brand: "Upper Deck", team: "Mariners", notes: "keep", estValueCents: 500, title: "1989 Upper Deck Ken Griffey",
      status: "needs_review",
    });
    db.insert(images).values({ itemId: id, role: "front", file: "a.avif", thumbFile: "a-t.avif", width: 1, height: 1, bytes: 1 }).run();
    const r = ok(run(`ID,Player,Value\n${id},Ken Griffey Jr.,12.50\n`));
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect(get(id)).toMatchObject({
      player: "Ken Griffey Jr.", manualValueCents: 1250, team: "Mariners", notes: "keep", estValueCents: 500, status: "needs_review",
      title: "1989 Upper Deck Ken Griffey Jr.", updatedAt: NOW,
    });
    expect(db.select().from(images).where(eq(images.itemId, id)).all()).toHaveLength(1);
  });

  it("counts a row with nothing new as no change", () => {
    const id = add({ player: "A", year: 1990 });
    const p = ok(check(`ID,Player,Year\n${id},A,1990\n`));
    expect(p.counts).toMatchObject({ updated: 0, unchanged: 1 });
    expect(run(`ID,Player,Year\n${id},A,1990\n`)).toHaveProperty("error");
  });

  it("sold and removed items are not in the collection: an ID of one is refused, and the Status column never changes a status", () => {
    const sold = add({ player: "Sold one", status: "sold", soldPriceCents: 500 });
    const live = add({ player: "Here", status: "confirmed" });
    const p = ok(check(`ID,Player,Status\n${sold},A,confirmed\n${live},B,sold\n`));
    expect(p.problems.map((x) => x.message)).toEqual([
      `Row 2: The item with ID ${sold} is marked sold or removed. Put it back in your collection first, or clear the ID to add this row as new.`,
    ]);
    ok(run(`ID,Player,Status\n${live},B,sold\n`));
    expect(get(live)).toMatchObject({ player: "B", status: "confirmed" });
    expect(get(sold)).toMatchObject({ player: "Sold one", status: "sold", soldPriceCents: 500 });
  });

  it("refuses an unknown, deleted or repeated ID, and a change of kind", () => {
    const gone = add({ player: "Gone", deletedAt: T0 });
    const live = add({ player: "Here" });
    const p = ok(check(`ID,Player,Kind\n99,A,card\n${gone},B,card\n${live},C,card\n${live},D,card\n${live},E,sealed\n`));
    expect(p.problems.map((x) => x.message)).toEqual([
      "Row 2: There is no item with ID 99 in your collection (it may have been deleted). Clear the ID to add this row as new.",
      `Row 3: There is no item with ID ${gone} in your collection (it may have been deleted). Clear the ID to add this row as new.`,
      `Row 5: ID ${live} is also on row 4. Each item can be on one row only.`,
      `Row 6: ID ${live} is also on row 4. Each item can be on one row only.`,
    ]);
  });
});

describe("rows that look like one you already have", () => {
  const text = "Player,Year,Brand,Card #,Qty\nKén GRIFFEY Jr,1989,upper deck,#1,2\nNew Card,1990,Topps,5,1\n";
  let have: number;
  beforeEach(() => { have = add({ player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", quantity: 3, title: "1989 Upper Deck #1 Ken Griffey Jr." }); });

  it("matches by year, brand, card number and player, case and accents ignored", () => {
    expect(duplicateKey({ year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr." }))
      .toBe(duplicateKey({ year: 1989, brand: "upper deck", cardNumber: "#1", player: "Kén GRIFFEY Jr" }));
    const p = ok(check(text));
    expect(p.counts).toMatchObject({ added: 1, duplicates: 1 });
    expect(p.duplicates).toEqual([{ row: 2, title: expect.any(String), matchId: have, matchTitle: "1989 Upper Deck #1 Ken Griffey Jr." }]);
  });

  it("skips them by default", () => {
    ok(run(text));
    expect(all()).toHaveLength(2);
    expect(get(have).quantity).toBe(3);
  });

  it("imports them as new when chosen", () => {
    ok(run(text, { ...OPTS, duplicates: "new" }));
    expect(all()).toHaveLength(3);
  });

  it("adds to the quantity when chosen", () => {
    const r = ok(run(text, { ...OPTS, duplicates: "add" }));
    expect(r).toMatchObject({ added: 1, updated: 1 });
    expect(get(have).quantity).toBe(5);
    expect(all()).toHaveLength(2);
  });
});

describe("all or nothing", () => {
  it("a failure on the last row saves nothing at all", () => {
    const id = add({ player: "Old" });
    const text = `ID,Player,Location\n,New One,Box 9\n,New Two,\n${id},Changed,\n`;
    setImportHooksForTests({ beforeSave: (i) => { if (i === 2) throw new Error("forced"); } });
    try {
      expect(() => applyImport(text, guess(text), OPTS, { skipProblems: false }, db, NOW)).toThrow("forced");
    } finally {
      setImportHooksForTests();
    }
    expect(all()).toHaveLength(1);
    expect(get(id).player).toBe("Old");
    expect(db.select().from(locations).all()).toHaveLength(0);
    expect(db.select().from(bulkOps).all()).toHaveLength(0);
    expect(db.select().from(valuations).all()).toHaveLength(0);
  });

  it("refuses when the collection changed since the check", () => {
    const text = "Player\nA\n";
    const p = ok(check(text));
    add({ player: "A", year: 1990 });
    expect(applyImport("Player\nA\nB\n", guess(text), OPTS, { skipProblems: false, expected: p.counts }, db, NOW))
      .toEqual({ error: "Your collection changed since the check. Check the file again." });
    expect(all()).toHaveLength(1);
  });
});

describe("price guide after an import", () => {
  const CARD = { kind: "card" as const, year: 1989, brand: "Upper Deck", player: "Ken Griffey Jr.", cardNumber: "1" };

  it("new and updated items without an owner value get a guide price; an owner value is never touched", () => {
    const upd = add({ ...CARD, team: "Mariners" });
    const own = add({ ...CARD, cardNumber: "2", team: "Mariners", manualValueCents: 777, updatedAt: T0 });
    const r = ok(run(`ID,Year,Brand,Card number,Player,Team\n,1989,Upper Deck,7,Ken Griffey Jr.,Mariners\n${upd},1989,Upper Deck,1,Ken Griffey Jr.,Rookies\n${own},1989,Upper Deck,2,Ken Griffey Jr.,Rookies\n`));
    expect(r).toMatchObject({ added: 1, updated: 2 });
    const made = all().find((i) => i.id !== upd && i.id !== own)!;
    expect(get(made.id)).toMatchObject({ valueSource: "price_guide", manualValueCents: null });
    expect(get(made.id).estValueCents).toBeGreaterThan(0);
    expect(get(upd)).toMatchObject({ valueSource: "price_guide", team: "Rookies" });
    expect(get(own)).toMatchObject({ manualValueCents: 777, estValueCents: null, valueSource: null, team: "Rookies" });
  });

  it("a typed value in the file stays the owner's, with no guide price", () => {
    ok(run("Year,Brand,Card number,Player,Value\n1989,Upper Deck,1,Ken Griffey Jr.,12.50\n"));
    expect(all()[0]).toMatchObject({ manualValueCents: 1250, estValueCents: null, valueSource: null });
  });

  it("undo still works after the guide price was added (the guide does not count as an edit)", () => {
    const upd = add({ ...CARD, team: "Mariners", updatedAt: T0 });
    const r = ok(run(`ID,Year,Brand,Card number,Player,Team\n,1989,Upper Deck,5,Ken Griffey Jr.,Cubs\n${upd},1989,Upper Deck,1,Ken Griffey Jr.,Rookies\n`));
    expect(get(upd).valueSource).toBe("price_guide");
    expect(ok(undoBulk(r.opId, db, LATER))).toMatchObject({ restored: 1, removed: 1, skipped: 0, kind: "import" });
    expect(get(upd)).toMatchObject({ team: "Mariners", updatedAt: T0 });
    expect(all().filter((i) => i.deletedAt != null)).toHaveLength(1);
  });
});

describe("undo", () => {
  it("is one bulk change: added items go to Recently deleted, updated items get their old values back", () => {
    const id = add({ player: "Old", team: "Reds", updatedAt: T0 });
    const r = ok(run(`ID,Player,Team\n,Brand New,Cubs\n${id},Changed,\n`));
    const op = latestUndoable(db, NOW);
    expect(op).toMatchObject({ id: r.opId, summary: "Imported a spreadsheet: 1 added, 1 updated", itemCount: 2 });
    expect(get(id)).toMatchObject({ player: "Changed", team: null });
    const made = all().find((i) => i.player === "Brand New")!;
    expect(ok(undoBulk(r.opId, db, LATER))).toMatchObject({ restored: 1, removed: 1, skipped: 0, kind: "import" });
    expect(get(id)).toMatchObject({ player: "Old", team: "Reds", updatedAt: T0, deletedAt: null });
    expect(get(made.id).deletedAt).toEqual(LATER);
    expect(db.select().from(items).where(isNotNull(items.deletedAt)).all().map((i) => i.id)).toEqual([made.id]);
  });

  it("leaves items edited since the import alone", () => {
    const r = ok(run("Player\nA\n"));
    const made = all()[0];
    db.update(items).set({ notes: "mine", updatedAt: new Date(NOW.getTime() + 1000) }).where(eq(items.id, made.id)).run();
    expect(ok(undoBulk(r.opId, db, LATER))).toMatchObject({ restored: 0, skipped: 1 });
    expect(get(made.id).deletedAt).toBeNull();
  });

  it("removes the places the import made when undo leaves them empty and unchanged (review fix 9)", () => {
    const r = ok(run("Player,Box\nA,Box 9\nB,Box 10\nC,Box 11\n"));
    const place = (name: string) => db.select().from(locations).all().find((l) => l.name === name);
    // Box 10: the owner renamed nothing but wrote a note on it. Box 11: another item was moved in since.
    db.update(locations).set({ notes: "shelf" }).where(eq(locations.name, "Box 10")).run();
    const other = add({ player: "Mine", locationId: place("Box 11")!.id });
    expect(ok(undoBulk(r.opId, db, LATER))).toMatchObject({ restored: 0, removed: 3, skipped: 0, kind: "import" });
    expect(place("Box 9")).toBeUndefined();
    expect(place("Box 10")).toBeDefined();
    expect(place("Box 11")).toBeDefined();
    expect(get(other).locationId).toBe(place("Box 11")!.id);
    // The item in the bin from Box 9 no longer points at a place that is gone.
    const a = all().find((i) => i.player === "A")!;
    expect(a).toMatchObject({ locationId: null, deletedAt: LATER });
  });

  it("keeps a place the import made when an item it added stays (edited since)", () => {
    const r = ok(run("Player,Box\nA,Box 9\n"));
    const made = all()[0];
    db.update(items).set({ notes: "mine", updatedAt: new Date(NOW.getTime() + 1000) }).where(eq(items.id, made.id)).run();
    ok(undoBulk(r.opId, db, LATER));
    expect(db.select().from(locations).all().map((l) => l.name)).toEqual(["Box 9"]);
    expect(get(made.id).locationId).not.toBeNull();
  });

  it("forgets added items purged from the bin", async () => {
    const r = ok(run("Player\nA\n"));
    ok(undoBulk(r.opId, db, LATER));
    const made = all()[0];
    await purgeItems([made.id], db);
    expect(db.select().from(bulkOps).where(eq(bulkOps.id, r.opId)).all()).toHaveLength(0);
  });
});

describe("round trip", () => {
  it("export three items, change a value in the text, import: the same three are updated and none added", () => {
    const ids = [
      add({ player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", sport: "baseball", condition: "near_mint", isRookie: true, rookieState: "yes", rookieSource: "owner", manualValueCents: 1000, title: "x" }),
      add({ player: "Frank Thomas", year: 1990, brand: "Topps", cardNumber: "414", notes: "line one\nline two, with \"quotes\"", rookieState: "unknown", title: "y" }),
      add({ kind: "sealed", year: 1991, brand: "Fleer", productType: "box", sealState: "factory_sealed", notes: "=not a formula", title: "z" }),
    ];
    const before = ids.map(get);
    const csv = itemsToCsv(before, new Map());
    // Same file back: nothing changes.
    const same = ok(previewImport(csv, guess(csv), OPTS, db, NOW));
    expect(same.counts).toMatchObject({ rows: 3, added: 0, updated: 0, unchanged: 3, problems: 0 });
    // Change the second card's player and the first card's own value, as a spreadsheet would.
    const edited = csv.replace("Frank Thomas", "Frank E. Thomas").replaceAll(",10.00,", ",25.00,");
    expect(edited).not.toBe(csv);
    const p = ok(previewImport(edited, guess(edited), OPTS, db, NOW));
    expect(p.counts).toMatchObject({ rows: 3, added: 0, updated: 2, unchanged: 1, problems: 0 });
    const r = ok(applyImport(edited, guess(edited), OPTS, { skipProblems: false, expected: p.counts }, db, NOW));
    expect(r).toMatchObject({ added: 0, updated: 2 });
    expect(all()).toHaveLength(3);
    expect(get(ids[0]).manualValueCents).toBe(2500);
    expect(get(ids[1])).toMatchObject({ player: "Frank E. Thomas", notes: "line one\nline two, with \"quotes\"", rookieState: "unknown" });
    expect(get(ids[2])).toEqual(before[2]);
  });

  it("the export writes plain labels; that file and an old export with code words both import as the same items (review 7)", () => {
    const ids = [
      add({ player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", sport: "baseball", condition: "near_mint", rarityTier: "minor_star", status: "needs_review", confidence: 0.8, title: "x" }),
      add({ kind: "sealed", year: 1991, brand: "Fleer", setName: "Fleer", sport: "basketball", productType: "rack_pack", sealState: "possibly_resealed", title: "z" }),
    ];
    const before = ids.map(get);
    const csv = itemsToCsv(before, new Map());
    const rows = csv.replace(/^\uFEFF/, "").split("\r\n");
    const header = rows[0]!.split(",");
    const cell = (line: number, h: string) => rows[line]!.split(",")[header.indexOf(h)];
    expect([cell(1, "ID"), cell(1, "Kind"), cell(1, "Status"), cell(1, "Sport"), cell(1, "Condition"), cell(1, "Rarity"), cell(1, "Confidence")])
      .toEqual([String(ids[0]), "Card", "Needs review", "Baseball", "Near mint", "Minor star", "80%"]);
    expect([cell(2, "Kind"), cell(2, "Sport"), cell(2, "Product type"), cell(2, "Seal state")]).toEqual(["Sealed product", "Basketball", "Rack pack", "May have been resealed"]);
    expect(ok(previewImport(csv, guess(csv), OPTS, db, NOW)).counts).toMatchObject({ rows: 2, added: 0, updated: 0, unchanged: 2, problems: 0 });
    // An export made before this change: code words and 0.8.
    const old = [
      "ID,Kind,Status,Title,Sport,Year,Brand,Set,Card number,Player,Rarity,Condition,Product type,Seal state,Confidence",
      `${ids[0]},card,needs_review,x,baseball,1989,Upper Deck,,1,Ken Griffey Jr.,minor_star,near_mint,,,0.8`,
      `${ids[1]},sealed,confirmed,z,basketball,1991,Fleer,Fleer,,,,,rack_pack,possibly_resealed,`,
    ].join("\r\n");
    expect(ok(previewImport(old, guess(old), OPTS, db, NOW)).counts).toMatchObject({ rows: 2, added: 0, updated: 0, unchanged: 2, problems: 0 });
    // As new rows (no ID), the labels and the code words give the same fields.
    const fresh = (text: string) => text.split("\r\n").map((l, i) => (i === 0 ? l : l.replace(/^[^,]*/, ""))).join("\r\n");
    const keep: ImportOptions = { ...OPTS, duplicates: "new" };
    ok(applyImport(fresh(csv), guess(csv), keep, { skipProblems: false }, db, NOW));
    ok(applyImport(fresh(old), guess(old), keep, { skipProblems: false }, db, NOW));
    const pick = (i: Item) => [i.kind, i.sport, i.condition, i.rarityTier, i.productType, i.sealState];
    const made = all().slice(2).map(pick);
    expect(made).toEqual([...before, ...before].map(pick));
  });
});
