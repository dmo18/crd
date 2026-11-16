import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, bulkOps, items, type Item, type NewItem } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";
import { recognizedItemSchema, type ReadEvidence } from "@/lib/recognition/types";
import { applyBulk, previewBulk, undoBulk } from "./bulk";
import { itemFromRecognition } from "./from-recognition";
import { mergeInto } from "./duplicates";
import { KEY_LIST_NOTE, readRookie, rookieAsk, rookieEvidence, rookieFromScan, withRookie } from "./rookie";
import { BEFORE_1990, parseSuggestion, suggestionFromRead } from "./serial";
import { updateItem } from "./update";

let owner = true;
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Error("redirect /login"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const actions = await import("./suggest-actions");
const { answerRookie, answerSerial } = await import("./suggest");
const { unlinkCatalogCard } = await import("@/lib/catalog/apply");
const { dismissCandidates, pickCandidate } = await import("@/lib/catalog/pick");
const { serializeCatalog } = await import("@/lib/catalog/candidates");
const { chooseVersion } = await import("@/lib/catalog/versions");

let db: Db;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get() as Item;
const insert = (over: Partial<NewItem> = {}) =>
  db.insert(items).values({ kind: "card", title: "Griffey", status: "needs_review", year: 1989, player: "Ken Griffey Jr.", createdAt: new Date(1000), updatedAt: new Date(1000), ...over }).returning({ id: items.id }).get().id;
const form = (f: Record<string, string | number>) => { const d = new FormData(); for (const [k, v] of Object.entries(f)) d.set(k, String(v)); return d; };
const audits = () => db.select().from(auditEvents).all().map((a) => a.event);
const empty = { message: null };

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  owner = true;
});
afterEach(() => setDbForTests(undefined));

const read = (over: Record<string, unknown>, evidence?: ReadEvidence) =>
  ({ ...recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "Ken Griffey Jr.", year: 1995, ...over }), ...(evidence ? { evidence } : {}) });
const ctx = { scanId: 1, locationId: null, valueSource: "ai_estimate" as const, now: new Date(1000) };

describe("rookie evidence: one test per row and per conflict", () => {
  it("key list yes: yes, with the list's note", () => {
    const e = rookieEvidence({ keyCard: { isRookie: true, note: "Famous rookie card" } });
    expect(e.suggested).toBe("yes");
    expect(e.lines).toEqual([{ text: "The built-in key card list says this is a rookie card: Famous rookie card", source: "key_list" }]);
  });
  it("key list no: no, with the list's note", () => {
    const e = rookieEvidence({ keyCard: { isRookie: false, note: "His 1985 Topps Olympic card came first" } });
    expect(e.suggested).toBe("no");
    expect(e.lines[0].text).toMatch(/not the rookie card: His 1985 Topps Olympic card came first/);
  });
  it("catalog tag RC alone: yes, from MyCardfolio", () => {
    const e = rookieEvidence({ catalogTags: ["RC"] });
    expect(e.suggested).toBe("yes");
    expect(e.lines).toEqual([{ text: "The catalog marks this card RC (rookie card). From MyCardfolio", source: "catalog" }]);
  });
  it("the read word alone: not sure, with the plain warning", () => {
    const e = rookieEvidence({ readWord: true });
    expect(e.suggested).toBe("unknown");
    expect(e.lines[0].text).toMatch(/does not make it the rookie card/);
  });
  it("nothing at all: nothing is shown", () => {
    expect(rookieEvidence({})).toEqual({ lines: [], suggested: null });
    expect(rookieEvidence({ catalogTags: ["IR", "TC"] })).toEqual({ lines: [], suggested: null });
  });
  it("sources that agree on yes: yes, both lines", () => {
    const e = rookieEvidence({ keyCard: { isRookie: true }, catalogTags: ["RC"], readWord: true });
    expect(e.suggested).toBe("yes");
    expect(e.lines.map((l) => l.source)).toEqual(["key_list", "catalog", "reading"]);
  });
  it("conflict: key list says no, the catalog says RC: disputed with both lines", () => {
    const e = rookieEvidence({ keyCard: { isRookie: false }, catalogTags: ["RC"] });
    expect(e.suggested).toBe("disputed");
    expect(e.lines.map((l) => l.source)).toEqual(["key_list", "catalog"]);
  });
  it("conflict: key list says no and the word ROOKIE is read: stays no, both lines (a word alone is not proof)", () => {
    const e = rookieEvidence({ keyCard: { isRookie: false }, readWord: true });
    expect(e.suggested).toBe("no");
    expect(e.lines).toHaveLength(2);
  });
  it("a reprint on the key list is not sure, never yes", () => {
    const e = rookieEvidence({ keyCard: { isRookie: true }, reprint: true });
    expect(e.suggested).toBe("unknown");
    expect(e.lines[0].text).toMatch(/REPRINT/);
  });
});

describe("what a scan writes", () => {
  it("the read word and the catalog tag never write the mark, only the key list hit does", () => {
    expect(rookieFromScan(true, false, { rookieWord: true })).toMatchObject({ isRookie: false, rookieState: null, rookieSource: "reading" });
    expect(rookieFromScan(true, false, { keyCard: { isRookie: true } })).toEqual(withRookie("yes", "key_list", KEY_LIST_NOTE));
    expect(rookieFromScan(true, false, { keyCard: { isRookie: false }, rookieWord: true })).toMatchObject({ rookieState: "no", rookieSource: "key_list" });
    expect(rookieFromScan(false, true, { keyCard: { isRookie: true } })).toMatchObject({ isRookie: false, rookieState: null });
  });

  it("a scan never writes serialNumber, serialCopy or serialEdition; the read waits as a suggestion", () => {
    const row = itemFromRecognition(read({}, { serial: { text: "045/100", line: "045/100", weak: false, why: [] } }), ctx);
    expect(row).toMatchObject({ serialNumber: null, serialCopy: null, serialEdition: null });
    expect(parseSuggestion(row.serialSuggested)).toEqual({ copy: "045", edition: "100", line: "045/100", weak: false, why: [] });
  });

  it("the paid reader's serial text takes the same road, and bad text makes no suggestion", () => {
    expect(parseSuggestion(itemFromRecognition(read({ serialNumber: "45 of 100" }), ctx).serialSuggested)).toMatchObject({ copy: "45", edition: "100", weak: false });
    expect(itemFromRecognition(read({ serialNumber: "1 of 1 promo" }), ctx).serialSuggested).toBeNull();
    expect(itemFromRecognition(read({ serialNumber: "0/100" }), ctx).serialSuggested).toBeNull();
    expect(itemFromRecognition(read({}), ctx).serialSuggested).toBeNull();
    expect(itemFromRecognition(recognizedItemSchema.parse({ kind: "sealed", confidence: 0.9, serialNumber: "45/100" }), ctx).serialSuggested).toBeNull();
  });

  it("a card from before 1990 and a copy above the edition are weak", () => {
    const old = suggestionFromRead({ text: "12/50" }, 1987);
    expect(old).toMatchObject({ weak: true, why: [BEFORE_1990] });
    const above = suggestionFromRead({ text: "150/100" }, 1995);
    expect(above).toMatchObject({ copy: "150", edition: "100", weak: true });
    expect(suggestionFromRead({ text: "45/100" }, 1995)).toMatchObject({ weak: false });
  });
});

describe("answering the serial question", () => {
  const withSuggestion = (text: string, year: number, over: Partial<NewItem> = {}) =>
    insert({ year, serialSuggested: JSON.stringify(suggestionFromRead({ text, line: text }, year)), ...over });

  it("Yes writes the parts and the text, clears the suggestion and marks nothing else", async () => {
    const id = withSuggestion("045/100", 1995, { fieldSources: JSON.stringify({ player: "reading" }) });
    const before = get(id);
    expect(await actions.serialAnswerAction(empty, form({ id, answer: "yes" }))).toEqual({ message: null });
    const after = get(id);
    expect(after).toMatchObject({ serialCopy: "045", serialEdition: "100", serialNumber: "045/100", serialSuggested: null });
    expect({ ...after, ...{ serialCopy: null, serialEdition: null, serialNumber: null, updatedAt: null } }).toEqual({ ...before, serialSuggested: null, updatedAt: null });
    expect(audits()).toContain("serial_confirmed");
  });

  it("a weak read has no Yes: the server refuses it and keeps the suggestion", async () => {
    const id = withSuggestion("12/50", 1987);
    const r = await actions.serialAnswerAction(empty, form({ id, answer: "yes" }));
    expect(r.message).toMatch(/not sure enough/);
    expect(get(id)).toMatchObject({ serialNumber: null, serialCopy: null });
    expect(get(id).serialSuggested).not.toBeNull();
  });

  it("Fix it writes the typed boxes, even for a weak read; bad boxes are refused", async () => {
    const id = withSuggestion("12/50", 1987);
    expect((await actions.serialAnswerAction(empty, form({ id, answer: "fix", serialCopy: "7", serialEdition: "5" }))).message).toMatch(/copy cannot be higher/);
    expect((await actions.serialAnswerAction(empty, form({ id, answer: "fix", serialCopy: "", serialEdition: "" }))).message).toMatch(/print run/);
    expect((await actions.serialAnswerAction(empty, form({ id, answer: "fix", serialCopy: "0", serialEdition: "50" }))).message).toMatch(/cannot be 0/);
    expect(get(id).serialSuggested).not.toBeNull();
    expect(await actions.serialAnswerAction(empty, form({ id, answer: "fix", serialCopy: "012", serialEdition: "50" }))).toEqual({ message: null });
    expect(get(id)).toMatchObject({ serialNumber: "012/50", serialCopy: "012", serialEdition: "50", serialSuggested: null });
  });

  it("No serial number clears the suggestion and writes nothing", async () => {
    const id = withSuggestion("045/100", 1995);
    expect(await actions.serialAnswerAction(empty, form({ id, answer: "no" }))).toEqual({ message: null });
    expect(get(id)).toMatchObject({ serialNumber: null, serialCopy: null, serialEdition: null, serialSuggested: null });
  });

  it("refuses without a session, a bad answer, a missing suggestion and a non card", async () => {
    const id = withSuggestion("045/100", 1995);
    owner = false;
    await expect(actions.serialAnswerAction(empty, form({ id, answer: "yes" }))).rejects.toThrow(/login/);
    owner = true;
    expect(get(id).serialSuggested).not.toBeNull();
    expect((await actions.serialAnswerAction(empty, form({ id, answer: "maybe" }))).message).toBeTruthy();
    expect((await actions.serialAnswerAction(empty, form({ id: 999, answer: "yes" }))).message).toMatch(/no longer exists/);
    const plain = insert();
    expect((await actions.serialAnswerAction(empty, form({ id: plain, answer: "yes" }))).message).toMatch(/nothing to answer/);
    const sealed = insert({ kind: "sealed" });
    expect(answerSerial(sealed, { kind: "no" }, db)).toMatchObject({ ok: false });
  });
});

describe("answering the rookie question", () => {
  it("each answer is the owner's, through withRookie, and writes an audit row", async () => {
    const id = insert(withRookie("yes", "key_list", KEY_LIST_NOTE));
    for (const s of ["no", "unknown", "disputed", "yes"] as const) {
      expect(await actions.rookieAnswerAction(empty, form({ id, answer: s }))).toEqual({ message: null });
      expect(get(id)).toMatchObject({ rookieState: s, rookieSource: "owner", rookieNote: null, isRookie: s === "yes" });
    }
    expect(audits().filter((e) => e === "rookie_set")).toHaveLength(4);
  });

  it("refuses without a session, a bad answer and a missing item", async () => {
    const id = insert();
    owner = false;
    await expect(actions.rookieAnswerAction(empty, form({ id, answer: "yes" }))).rejects.toThrow(/login/);
    owner = true;
    expect((await actions.rookieAnswerAction(empty, form({ id, answer: "perhaps" }))).message).toBeTruthy();
    expect(answerRookie(999, "yes", db)).toMatchObject({ ok: false });
    expect(get(id)).toMatchObject({ rookieState: null, isRookie: false });
  });

  it("the owner's answer survives a look up, a link, an unlink, a version choice, a combine and a second scan of the same card", () => {
    const griffey = { source: "mycardfolio" as const, sourceId: "551033", url: "https://mycardfolio.com/x/551033", sourceSetId: "9179", verified: true, sport: "baseball" as const, year: 1989, brand: "Upper Deck", setName: null, cardNumber: "1", player: "Ken Griffey Jr.", otherPlayers: [], variation: null, tags: ["RC"], score: 3, why: "Name agrees" };
    const id = insert({ brand: "Upper Deck", cardNumber: "1", ...withRookie("no", "key_list", KEY_LIST_NOTE), catalogCandidates: serializeCatalog({ status: "candidates", items: [griffey] }, new Date()) });
    expect(answerRookie(id, "disputed", db)).toMatchObject({ ok: true });
    const mine = { isRookie: false, rookieState: "disputed", rookieSource: "owner" };
    expect(dismissCandidates(id, db)).toEqual({ ok: true });
    db.update(items).set({ catalogCandidates: serializeCatalog({ status: "candidates", items: [griffey] }, new Date()) }).where(eq(items.id, id)).run();
    expect(pickCandidate(id, 0, "551033", db)).toMatchObject({ ok: true });
    expect(get(id)).toMatchObject(mine);
    expect(unlinkCatalogCard(id, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject(mine);
    expect(chooseVersion(id, { position: 0, listAt: 1, text: null })).toBeTruthy();
    expect(get(id)).toMatchObject(mine);
    // A second scan of the same card is a new item, with the key list's answer; combining keeps the target's answer.
    const again = insert({ brand: "Upper Deck", cardNumber: "1", status: "needs_review", ...itemFromRecognition(read({ isRookie: true, year: 1989, brand: "Upper Deck", cardNumber: "1" }, { keyCard: { isRookie: true } }), ctx), scanId: null });
    db.update(items).set({ status: "confirmed" }).where(eq(items.id, id)).run();
    expect(get(again)).toMatchObject({ rookieState: "yes", rookieSource: "key_list" });
    expect(mergeInto(again, id, db)).toMatchObject({ ok: true });
    expect(get(id)).toMatchObject(mine);
  });
});

describe("the question shows only when there is evidence", () => {
  const view = (over: Partial<Item>) => rookieAsk({ kind: "card", isRookie: false, rookieState: null, rookieSource: null, rookieNote: null, rarityNotes: null, ...over });
  it("a key list hit asks with its line, a read word asks, old items and the owner's answer ask nothing", () => {
    expect(view(withRookie("yes", "key_list", KEY_LIST_NOTE))).toMatchObject({ suggested: "yes", current: "yes" });
    expect(view(withRookie("no", "key_list", KEY_LIST_NOTE))).toMatchObject({ suggested: "no", current: "no" });
    expect(view(withRookie("unknown", "key_list", "x"))).toMatchObject({ suggested: "unknown" });
    expect(view(withRookie("unknown", "key_list", "x"))!.lines[0]).toMatch(/REPRINT/);
    expect(view({ rookieSource: "reading", rookieNote: "The word ROOKIE is on the card. That alone does not make it the rookie card (it may be an All-Star Rookie cup or a Rated Rookie of a later year)" })).toMatchObject({ suggested: "unknown", current: null });
    expect(view({})).toBeNull();
    expect(view({ isRookie: true })).toBeNull();
    expect(view(withRookie("yes", "owner"))).toBeNull();
    expect(rookieAsk({ kind: "sealed", isRookie: false, rookieState: null, rookieSource: "reading", rookieNote: "x", rarityNotes: null })).toBeNull();
    expect(view({ rookieSource: "reading", rookieNote: "The AI reader thinks this is a rookie card. Check it before relying on it" })).toMatchObject({ current: null });
  });
});

describe("the item form and the key rookie answers keep the old columns in step", () => {
  it("empty serial boxes keep an old whole serial text that does not split", () => {
    const id = insert({ kind: "card", serialNumber: "1 of 1 promo" });
    expect(updateItem(id, { quantity: "1", serialCopy: "", serialEdition: "" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "1 of 1 promo", serialCopy: null, serialEdition: null });
    // The text box itself still changes it: kept whole, split, or cleared.
    expect(updateItem(id, { quantity: "1", serialNumber: "1 of 1 promo", serialCopy: "", serialEdition: "" }, db)).toEqual({ ok: true });
    expect(get(id).serialNumber).toBe("1 of 1 promo");
    expect(updateItem(id, { quantity: "1", serialNumber: "45 of 100", serialCopy: "", serialEdition: "" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "45/100", serialCopy: "45", serialEdition: "100" });
    const id2 = insert({ serialNumber: "1 of 1 promo" });
    expect(updateItem(id2, { quantity: "1", serialNumber: "", serialCopy: "", serialEdition: "" }, db)).toEqual({ ok: true });
    expect(get(id2).serialNumber).toBeNull();
    // Boxes filled win over an old whole text.
    const id3 = insert({ serialNumber: "1 of 1 promo" });
    expect(updateItem(id3, { quantity: "1", serialCopy: "003", serialEdition: "10" }, db)).toEqual({ ok: true });
    expect(get(id3)).toMatchObject({ serialNumber: "003/10", serialCopy: "003", serialEdition: "10" });
  });

  it("bulk set rookie no skips cards with no rookie mark; the preview counts only real changes", () => {
    const plain = insert();
    const yes = insert(withRookie("yes", "owner"));
    const old = insert({ isRookie: true });
    const noMark = { type: "set", field: "isRookie", value: false, onlyEmpty: false } as const;
    expect(previewBulk({ ids: [plain] }, noMark, db)).toMatchObject({ count: 0 });
    expect(previewBulk({ ids: [plain, yes, old] }, noMark, db)).toMatchObject({ count: 2 });
    expect(applyBulk({ ids: [plain, yes, old] }, noMark, db, new Date(5000))).toMatchObject({ changed: 2 });
    expect(get(plain)).toMatchObject({ rookieState: null, rookieSource: null, isRookie: false });
  });

  it("undo of a bulk change stored before 0009 (only isRookie saved) leaves state and flag in step", () => {
    const id = insert({ isRookie: false });
    const r = applyBulk({ ids: [id] }, { type: "set", field: "isRookie", value: true, onlyEmpty: false }, db, new Date(5000));
    expect(r).toMatchObject({ changed: 1 });
    const opId = (r as { opId: number }).opId;
    // Rewrite the stored undo the way an old build saved it: only `isRookie` of the rookie columns.
    const op = db.select().from(bulkOps).where(eq(bulkOps.id, opId)).get()!;
    const data = JSON.parse(op.undo) as { v: number; items: [number, Record<string, unknown>][] };
    for (const [, old] of data.items) { delete old.rookieState; delete old.rookieSource; delete old.rookieNote; }
    db.update(bulkOps).set({ undo: JSON.stringify(data) }).where(eq(bulkOps.id, opId)).run();
    expect(get(id)).toMatchObject({ isRookie: true, rookieState: "yes" });
    expect(undoBulk(opId, db, new Date(6000))).toMatchObject({ restored: 1 });
    const back = get(id);
    expect(back).toMatchObject({ isRookie: false, rookieState: null, rookieSource: null, rookieNote: null });
    expect(readRookie(back).state).toBeNull();
  });
});

