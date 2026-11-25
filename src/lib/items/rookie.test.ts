import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, type Item, type NewItem } from "@/db/schema";
import { recognizedItemSchema, type ReadEvidence } from "@/lib/recognition/types";
import { applyBulk, previewBulk, undoBulk } from "./bulk";
import { createItem } from "./create";
import { itemFromRecognition } from "./from-recognition";
import { readRookie, withRookie } from "./rookie";
import { updateItem } from "./update";

/** The rule: once a state is recorded, `isRookie` is true exactly when it is `yes`. */
const inStep = (r: Pick<Item, "isRookie" | "rookieState">) => r.rookieState == null || r.isRookie === (r.rookieState === "yes");

describe("withRookie and readRookie", () => {
  it("writes the state, the flag, the source and a short note together", () => {
    expect(withRookie("yes", "key_list", "  The best known rookie card. ")).toEqual({ isRookie: true, rookieState: "yes", rookieSource: "key_list", rookieNote: "The best known rookie card." });
    for (const s of ["no", "unknown", "disputed"] as const) expect(withRookie(s, "owner")).toEqual({ isRookie: false, rookieState: s, rookieSource: "owner", rookieNote: null });
    expect(withRookie("yes", "owner", "x".repeat(300)).rookieNote).toHaveLength(200);
    expect(() => withRookie("maybe" as never, "owner")).toThrow();
  });

  it("reads old items as before: yes or nothing, source not recorded", () => {
    expect(readRookie({ isRookie: true, rookieState: null, rookieSource: null, rookieNote: null })).toEqual({ state: "yes", source: null, note: null, sourceRecorded: false });
    expect(readRookie({ isRookie: false, rookieState: null, rookieSource: null, rookieNote: null })).toEqual({ state: null, source: null, note: null, sourceRecorded: false });
    expect(readRookie({ ...withRookie("disputed", "owner"), rookieNote: "n" })).toEqual({ state: "disputed", source: "owner", note: "n", sourceRecorded: true });
  });
});

describe("state and isRookie never disagree after any write path", () => {
  let db: Db;
  beforeEach(() => { db = createDb(":memory:"); });
  const insert = (over: Partial<NewItem> = {}) =>
    db.insert(items).values({ kind: "card", title: "Old", createdAt: new Date(1000), updatedAt: new Date(1000), ...over }).returning({ id: items.id }).get().id;
  const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;

  it("the item form with the check box: only a change is written, as the owner's", () => {
    const old = insert({ isRookie: true });
    expect(updateItem(old, { quantity: "1", isRookie: true }, db)).toEqual({ ok: true });
    expect(get(old)).toMatchObject({ isRookie: true, rookieState: null, rookieSource: null });
    expect(updateItem(old, { quantity: "1", isRookie: false }, db)).toEqual({ ok: true });
    expect(get(old)).toMatchObject({ isRookie: false, rookieState: "no", rookieSource: "owner" });
    const listed = insert(withRookie("yes", "key_list", "From the list"));
    expect(updateItem(listed, { quantity: "1", isRookie: true, team: "Mariners" }, db)).toEqual({ ok: true });
    expect(get(listed)).toMatchObject({ isRookie: true, rookieState: "yes", rookieSource: "key_list", rookieNote: "From the list" });
    const disputed = insert(withRookie("disputed", "owner"));
    expect(updateItem(disputed, { quantity: "1", isRookie: false }, db)).toEqual({ ok: true });
    expect(get(disputed)).toMatchObject({ isRookie: false, rookieState: "disputed" });
    for (const id of [old, listed, disputed]) expect(inStep(get(id))).toBe(true);
  });

  it("the item form with the four way choice", () => {
    const id = insert({ isRookie: true });
    // Saving the answer already shown changes nothing; the plain flag alone never goes in.
    expect(updateItem(id, { quantity: "1", rookieState: "yes" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ isRookie: true, rookieState: null });
    for (const s of ["disputed", "unknown", "no", "yes"] as const) {
      expect(updateItem(id, { quantity: "1", rookieState: s }, db)).toEqual({ ok: true });
      expect(get(id)).toMatchObject({ rookieState: s, rookieSource: "owner", isRookie: s === "yes" });
    }
    expect(updateItem(id, { quantity: "1", rookieState: "" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ rookieState: "yes", isRookie: true });
    expect(updateItem(id, { quantity: "1", rookieState: "maybe" }, db)).toMatchObject({ ok: false });
    expect(get(id)).toMatchObject({ rookieState: "yes", isRookie: true });
  });

  it("add by hand: a ticked box is the owner's yes, an empty one records nothing", () => {
    const a = createItem("card", { player: "A", isRookie: true }, db);
    const b = createItem("card", { player: "B" }, db);
    const c = createItem("card", { player: "C", rookieState: "disputed" }, db);
    expect(a.ok && get(a.id)).toMatchObject({ isRookie: true, rookieState: "yes", rookieSource: "owner" });
    expect(b.ok && get(b.id)).toMatchObject({ isRookie: false, rookieState: null, rookieSource: null });
    expect(c.ok && get(c.id)).toMatchObject({ isRookie: false, rookieState: "disputed", rookieSource: "owner" });
    const sealed = createItem("sealed", { setName: "Box", isRookie: true }, db);
    expect(sealed.ok && get(sealed.id)).toMatchObject({ isRookie: false, rookieState: null });
  });

  it("bulk \"set rookie\" writes state yes or no with source owner, and undo puts all four back", () => {
    const old = insert({ isRookie: true });
    const plain = insert();
    const listed = insert(withRookie("no", "key_list", "Not his first card"));
    const disputed = insert(withRookie("disputed", "owner"));
    const sealed = insert({ kind: "sealed", productType: "box" });
    const all = [old, plain, listed, disputed, sealed];
    const before = all.map(get);
    const preview = previewBulk({ ids: all }, { type: "set", field: "isRookie", value: false, onlyEmpty: false }, db);
    // "No" on a card with no rookie mark has nothing to change: it is neither counted nor written.
    expect(preview).toMatchObject({ count: 2 });
    expect("samples" in preview && preview.samples.map((s) => [s.before, s.after])).toEqual([["Yes", "No"], ["Disputed", "No"]]);
    const r = applyBulk({ ids: all }, { type: "set", field: "isRookie", value: false, onlyEmpty: false }, db, new Date(5000));
    expect(r).toMatchObject({ changed: 2 });
    for (const id of [old, disputed]) expect(get(id)).toMatchObject({ isRookie: false, rookieState: "no", rookieSource: "owner", rookieNote: null });
    expect(get(plain)).toMatchObject({ isRookie: false, rookieState: null, rookieSource: null });
    expect(get(listed)).toMatchObject({ rookieState: "no", rookieSource: "key_list", rookieNote: "Not his first card" });
    expect(get(sealed)).toMatchObject({ rookieState: null, isRookie: false });
    for (const id of all) expect(inStep(get(id))).toBe(true);
    expect(undoBulk((r as { opId: number }).opId, db, new Date(6000))).toMatchObject({ restored: 2 });
    const noTime = (r: Item) => ({ ...r, updatedAt: null });
    expect(all.map(get).map(noTime)).toEqual(before.map(noTime));

    const yes = applyBulk({ ids: all }, { type: "set", field: "isRookie", value: true, onlyEmpty: false }, db, new Date(7000));
    // The old item already shows yes; it is left as it is.
    expect(yes).toMatchObject({ changed: 3 });
    expect(get(old)).toMatchObject({ isRookie: true, rookieState: null });
    for (const id of [plain, listed, disputed]) expect(get(id)).toMatchObject({ isRookie: true, rookieState: "yes", rookieSource: "owner" });
    for (const id of all) expect(inStep(get(id))).toBe(true);
  });

  it("a bulk rookie change of 500 items stays inside the Milestone 9 time limit", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ kind: "card" as const, title: "T", player: `P${i}`, createdAt: new Date(1000), updatedAt: new Date(1000) }));
    const ids = db.insert(items).values(rows).returning({ id: items.id }).all().map((r) => r.id);
    const started = performance.now();
    const r = applyBulk({ ids }, { type: "set", field: "isRookie", value: true, onlyEmpty: false }, db, new Date(5000));
    const ms = performance.now() - started;
    expect(r).toMatchObject({ changed: 500 });
    expect(ms).toBeLessThan(5_000);
    expect(db.select().from(items).all().every((row) => row.rookieState === "yes" && row.isRookie)).toBe(true);
  });

  it("a scan: a key list hit (passed explicitly) writes state, source and the fixed note; nothing else writes a state", () => {
    const read = (over: Record<string, unknown>, evidence?: ReadEvidence) => ({ ...recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "Ken Griffey Jr.", ...over }), ...(evidence ? { evidence } : {}) });
    const ctx = { scanId: 1, locationId: null, valueSource: "ai_estimate" as const, now: new Date(1000) };
    const hit = { keyCard: { isRookie: true } };
    // The reader's name no longer decides anything: only the explicit hit does.
    for (const recognizer of ["free", "sample", "claude-sonnet", null]) {
      expect(itemFromRecognition(read({ isRookie: true }, hit), { ...ctx, recognizer }), String(recognizer))
        .toMatchObject({ isRookie: true, rookieState: "yes", rookieSource: "key_list", rookieNote: "On the built-in key card list" });
    }
    expect(itemFromRecognition(read({}, { keyCard: { isRookie: false } }), ctx)).toMatchObject({ isRookie: false, rookieState: "no", rookieSource: "key_list", rookieNote: "On the built-in key card list" });
    // A card marked as a reprint is "not sure", never "yes".
    expect(itemFromRecognition(read({ isRookie: true }, { keyCard: { isRookie: true }, reprint: true }), ctx)).toMatchObject({ isRookie: false, rookieState: "unknown", rookieSource: "key_list" });
    // No hit: nothing is written as a state. The paid AI's yes and a read word wait as a question.
    expect(itemFromRecognition(read({ isRookie: false }), { ...ctx, recognizer: "free" })).toMatchObject({ isRookie: false, rookieState: null, rookieSource: null, rookieNote: null });
    expect(itemFromRecognition(read({ isRookie: true }), { ...ctx, recognizer: "claude-sonnet" })).toMatchObject({ isRookie: false, rookieState: null, rookieSource: "reading" });
    expect(itemFromRecognition(read({}, { rookieWord: true }), ctx)).toMatchObject({ isRookie: false, rookieState: null, rookieSource: "reading" });
    // Sealed and bulk never carry the mark.
    expect(itemFromRecognition(recognizedItemSchema.parse({ kind: "sealed", confidence: 0.9, isRookie: true }), ctx)).toMatchObject({ isRookie: false, rookieState: null, rookieSource: null });
    // A scan never writes the serial number or its parts, or anything else of this milestone.
    const row = itemFromRecognition(read({ isRookie: true, serialNumber: "045/100" }, hit), ctx);
    expect(row.serialNumber).toBeNull();
    expect(row.serialCopy).toBeNull();
    expect(row.serialEdition).toBeNull();
    for (const k of ["versionState", "versionSource", "versionOptions", "keptApartFrom"] as const) expect(row[k], k).toBeUndefined();
    const id = db.insert(items).values({ ...row, scanId: null }).returning({ id: items.id }).get().id;
    expect(get(id)).toMatchObject({ rookieState: "yes", isRookie: true, serialNumber: null, serialCopy: null, versionState: null });
    expect(inStep(get(id))).toBe(true);
  });
});

describe("a known key rookie of the price guide is offered as a question (review fix 14)", () => {
  const blank = { kind: "card" as const, isRookie: false, rookieState: null, rookieSource: null, rookieNote: null, rarityNotes: null };
  it("suggests yes for a matching key rookie, never sets it", async () => {
    const { rookieAsk } = await import("./rookie");
    const chipper = { ...blank, sport: "baseball" as const, year: 1991, brand: "Upper Deck", setName: null, cardNumber: "55", player: "Chipper Jones" };
    expect(rookieAsk(chipper)).toEqual({
      lines: ["The built-in price guide lists 1991 Upper Deck #55 Chipper Jones as a rookie card"], suggested: "yes", current: null,
    });
    // Another player on that number, no player, or a card that is not his rookie: nothing.
    expect(rookieAsk({ ...chipper, player: "Ken Griffey Jr." })).toBeNull();
    expect(rookieAsk({ ...chipper, player: null })).toBeNull();
    expect(rookieAsk({ ...blank, sport: "basketball" as const, year: 1987, brand: "Fleer", setName: null, cardNumber: "59", player: "Michael Jordan" })).toBeNull();
    // The owner's answer is final.
    expect(rookieAsk({ ...chipper, ...withRookie("no", "owner") })).toBeNull();
  });
});
