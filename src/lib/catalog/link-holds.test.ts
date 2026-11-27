import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, type Item } from "@/db/schema";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { HOLD_WORDS, recognizedItemSchema, type ReadEvidence, type RecognizedItem } from "@/lib/recognition/types";
import { FakeCatalog, recordedSearch } from "../../../tests/helpers/fake-catalog";
import { isVerifiedMatch, type FindRead } from "./find";
import { autoLinkIn, linkedFacts, lookUpAgain, resetLookupLimitForTests, reviewCatalogView, undoLink } from "./pick";
import { fieldsToCheck, markOwnerChanges, notReadFields, parseFirstSuggestion } from "./sources";

/**
 * Review fixes 1 to 3: a card the reader held back is never confirmed by an
 * automatic link (a reprint is not linked at all); a value from the catalog's
 * set list never confirms itself; Undo puts back everything the link changed.
 */

const MILACKI = recordedSearch("s1a_1992_donruss_101_milacki.json");
const T0 = new Date("2026-11-20T12:00:00Z");
let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
  resetLookupLimitForTests();
});

const get = (id: number): Item => db.select().from(items).where(eq(items.id, id)).get()!;

/** A scanned Milacki card with the verified match stored first, as the scan leaves it. */
function scanned(evidence: ReadEvidence, over: Partial<RecognizedItem> = {}, candidate = MILACKI[0]): number {
  const r: RecognizedItem = recognizedItemSchema.parse({
    kind: "card", confidence: 0.7, sourceIndex: 0, box: null, sport: "baseball", year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki", ...over,
  });
  r.evidence = { certainty: { year: "sure", brand: "sure", cardNumber: "sure", player: "sure", sport: "sure" }, ...evidence };
  r.catalog = { status: "matched", candidates: [{ ...candidate, score: 0, why: "Agrees with the card" }] };
  return db.insert(items).values(itemFromRecognition(r, { scanId: null as unknown as number, locationId: null, valueSource: "ai_estimate", now: T0 })).returning().get().id;
}

describe("fix 1: the reader's hold backs survive an automatic link", () => {
  it("a plain card with a verified match is linked and confirmed (unchanged rule C)", () => {
    const id = scanned({});
    expect(autoLinkIn(db, id, T0)).toBe(true);
    expect(get(id)).toMatchObject({ status: "confirmed", confidence: 0.75 });
  });

  it("a card marked REPRINT is never linked by itself: the original's entry stays a suggestion, with the reason shown", () => {
    const id = scanned({ reprint: true, hold: ["reprint"] }, { confidence: 0.6 });
    expect(parseFirstSuggestion(get(id).firstSuggestion)?.hold).toEqual(["reprint"]);
    expect(autoLinkIn(db, id, T0)).toBe(false);
    const item = get(id);
    expect(item).toMatchObject({ catalogCardId: null, status: "needs_review", confidence: 0.6 });
    const view = reviewCatalogView(item, db, T0)!;
    expect(view.status).toBe("candidates");
    expect(view.candidates[0]).toMatchObject({ sourceId: "2310072" });
    expect(view.hold).toEqual([HOLD_WORDS.reprint]);
  });

  it("one side of a many-cards scan, hard to read text, an error check or a key list guess: linked, but still waits for the owner", () => {
    for (const hold of [["one_side"], ["hard_to_read"], ["error_check"], ["key_list_guess"]] as const) {
      const id = scanned({ hold: [...hold] });
      expect(autoLinkIn(db, id, T0)).toBe(true);
      const item = get(id);
      expect(item.catalogCardId).not.toBeNull();
      expect(item).toMatchObject({ status: "needs_review", confidence: 0.7 });
      const facts = linkedFacts(item, db, T0)!;
      expect(facts.auto).toBe(true);
      expect(facts.hold).toEqual([HOLD_WORDS[hold[0]]]);
    }
  });
});

describe("review 7: the automatic link never files a possible copy of a card already in the collection", () => {
  it("a scanned card with a verified match and a confirmed twin is linked but waits; Look up again does the same", async () => {
    const owned = scanned({});
    db.update(items).set({ status: "confirmed" }).where(eq(items.id, owned)).run();
    const id = scanned({});
    expect(autoLinkIn(db, id, T0)).toBe(true);
    expect(get(id)).toMatchObject({ status: "needs_review" });
    expect(get(id).catalogCardId).not.toBeNull();

    const later = scanned({});
    db.update(items).set({ catalogCandidates: null }).where(eq(items.id, later)).run();
    const catalog = new FakeCatalog({ searches: { "1992 donruss 101 milacki": MILACKI } });
    const r = await lookUpAgain(later, { db, catalog, now: () => T0 });
    expect(r.ok && r.matched).toBe("1992 Donruss #101 Bob Milacki");
    expect(get(later).status).toBe("needs_review");
  });

  it("a card the owner already confirmed is never sent back to Review by Look up again", async () => {
    const first = scanned({});
    const mine = scanned({});
    db.update(items).set({ status: "confirmed", catalogCandidates: null }).where(eq(items.id, mine)).run();
    db.update(items).set({ status: "confirmed" }).where(eq(items.id, first)).run();
    const catalog = new FakeCatalog({ searches: { "1992 donruss 101 milacki": MILACKI } });
    await lookUpAgain(mine, { db, catalog, now: () => T0 });
    expect(get(mine).status).toBe("confirmed");
  });
});

describe("fix 2: a value from the catalog's set list never confirms itself", () => {
  it("a blank filled from the set list is marked checklist, kept out of the first reading, and asked about", () => {
    const id = scanned({ checklist: ["player"], certainty: { year: "sure", brand: "sure", cardNumber: "sure", player: "sure" } });
    const item = get(id);
    expect(JSON.parse(item.fieldSources!)).toMatchObject({ player: "checklist", cardNumber: "reading" });
    expect(parseFirstSuggestion(item.firstSuggestion)?.fields.player).toBeUndefined();
    expect(fieldsToCheck(item)).toContain("player");
    expect(notReadFields(item)).toEqual(["player"]);
  });

  it("the first scan: a player from the set list makes no verified match", () => {
    const read: FindRead = { sport: "baseball", year: 1992, brand: "Donruss", setName: null, cardNumber: "101", player: "Bob Milacki", team: null, unsure: [] };
    const offer = { ...MILACKI[0], score: 0, why: "", differs: null };
    expect(isVerifiedMatch(read, offer)).toBe(true);
    for (const f of ["player", "cardNumber", "year"] as const) expect(isVerifiedMatch({ ...read, notRead: [f] }, offer), f).toBe(false);
    // Maker or product must be the card's too.
    expect(isVerifiedMatch({ ...read, notRead: ["brand"] }, offer)).toBe(false);
    // The sport or team from elsewhere does not matter.
    expect(isVerifiedMatch({ ...read, notRead: ["sport", "team"] }, offer)).toBe(true);
  });

  it("Look up again: the set list's own row does not link the card it filled", async () => {
    const id = scanned({ checklist: ["player"] });
    // The scan's list is replaced by what the look up finds.
    db.update(items).set({ catalogCandidates: null }).where(eq(items.id, id)).run();
    const catalog = new FakeCatalog({ searches: { "1992 donruss 101 milacki": MILACKI } });
    const r = await lookUpAgain(id, { db, catalog, now: () => T0 });
    expect(r).toMatchObject({ ok: true, found: 1 });
    expect(r.ok && r.matched).toBeFalsy();
    expect(get(id)).toMatchObject({ catalogCardId: null, status: "needs_review" });
  });

  it("Look up again: the same card with the player read on the card links as before", async () => {
    const id = scanned({});
    db.update(items).set({ catalogCandidates: null }).where(eq(items.id, id)).run();
    const catalog = new FakeCatalog({ searches: { "1992 donruss 101 milacki": MILACKI } });
    const r = await lookUpAgain(id, { db, catalog, now: () => T0 });
    expect(r.ok && r.matched).toBe("1992 Donruss #101 Bob Milacki");
  });

  it("a key list or Wikidata value kept as reading is not counted as read from the card", () => {
    const id = scanned({ notRead: ["cardNumber", "sport"] });
    expect(notReadFields(get(id))).toEqual(["sport", "cardNumber"]);
  });
});

describe("fix 3: Undo puts back what the link changed", () => {
  const full = { ...MILACKI[0], setName: "Base Set Special", team: "Baltimore Orioles" };

  it("fields the link filled are blank again, the title, marks, status, confidence and version answer as they were", () => {
    const id = scanned({ certainty: { year: "sure", brand: "sure", cardNumber: "sure", player: "sure" } }, {}, full);
    const before = get(id);
    expect(autoLinkIn(db, id, T0)).toBe(true);
    const linked = get(id);
    expect(linked).toMatchObject({ team: "Baltimore Orioles", setName: "Base Set Special", status: "confirmed" });
    expect(undoLink(id, db, T0).ok).toBe(true);
    const back = get(id);
    for (const k of ["team", "setName", "title", "fieldSources", "status", "confidence", "versionState", "versionSource", "versionOptions", "player", "year", "brand", "cardNumber", "sport"] as const) {
      expect(back[k], k).toEqual(before[k]);
    }
    expect(reviewCatalogView(back, db, T0)?.candidates[0]).toMatchObject({ sourceId: "2310072" });
  });

  it("long after the link (more than 30 days) Undo still puts the status and fields back", () => {
    const id = scanned({}, {}, full);
    const before = get(id);
    autoLinkIn(db, id, T0);
    const later = new Date(T0.getTime() + 45 * 24 * 60 * 60 * 1000);
    expect(undoLink(id, db, later).ok).toBe(true);
    expect(get(id)).toMatchObject({ catalogCardId: null, status: before.status, confidence: before.confidence, team: null, setName: null, title: before.title });
  });

  it("a field the owner changed after the link stays as the owner made it", () => {
    const id = scanned({}, {}, full);
    autoLinkIn(db, id, T0);
    // What the item form does with an owner's change: the field becomes the owner's.
    const linked = get(id);
    db.update(items).set({ team: "Orioles", fieldSources: markOwnerChanges(linked, { team: "Orioles" }), title: linked.title }).where(eq(items.id, id)).run();
    expect(undoLink(id, db, T0).ok).toBe(true);
    const back = get(id);
    expect(back).toMatchObject({ team: "Orioles", setName: null });
    expect(JSON.parse(back.fieldSources!)).toMatchObject({ team: "owner" });
    expect(JSON.parse(back.fieldSources!).setName).toBeUndefined();
  });
});
