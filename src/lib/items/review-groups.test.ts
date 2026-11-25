import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { bulkOps, items, type NewItem } from "@/db/schema";
import { buildFirstSuggestion, fieldsToCheck, parseFieldSources, sourcesFor } from "@/lib/catalog/sources";
import { latestUndoable, undoBulk } from "./bulk";
import { findDuplicateMatches } from "./duplicates";
import { applyBulk, latestUndoable as latest } from "./bulk";
import { confirmFromReview } from "./review-confirm";
import { catalogPickOpen, groupingFactsFor, PICK_CATALOG_REASON, reviewGroupOf } from "./review-groups";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const griffey = { sport: "baseball", year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr." } as const;

/** A card as a scan files it: values read, marks "reading", the reader's unsure fields and holds kept. */
function scanned(values: Partial<NewItem> = {}, meta: { unsure?: ("year" | "brand" | "player" | "cardNumber")[]; hold?: ("reprint" | "one_side" | "error_check")[] } = {}) {
  const v = { ...griffey, ...values };
  return db.insert(items).values({
    kind: "card", status: "needs_review", title: "Card", ...v,
    fieldSources: sourcesFor(v, "reading"),
    firstSuggestion: buildFirstSuggestion(v, { confidence: 0.6, reader: "free", at: new Date(1000), unsure: meta.unsure, hold: meta.hold }),
    catalogCandidates: JSON.stringify({ v: 1, at: Date.now(), status: "none", reason: null, items: [] }),
    updatedAt: new Date(1000),
  }).returning().get();
}

const group = (id: number, differences: string[] = []) => {
  const item = db.select().from(items).where(eq(items.id, id)).get()!;
  return reviewGroupOf(item, { duplicate: findDuplicateMatches(id, db)[0] ?? null, catalogDifferences: differences, catalogPickOpen: false });
};

describe("Review groups", () => {
  it("ready: the four fields filled, nothing held back; Check this marks are listed", () => {
    const a = scanned({}, { unsure: ["year", "brand"] });
    expect(group(a.id)).toEqual({ group: "ready", reasons: [], check: ["Year", "Brand"] });
  });

  it("needs a look: a blank field, a hold, a contradiction or a disputed rookie mark", () => {
    expect(group(scanned({ brand: null, player: "Bo Jackson", cardNumber: "8" }).id)).toMatchObject({ group: "look", reasons: ["Blank: Brand"] });
    expect(group(scanned({ player: "A One", cardNumber: "2" }, { hold: ["reprint"] }).id).reasons).toEqual(["Marked REPRINT, so not the original card"]);
    expect(group(scanned({ player: "A Two", cardNumber: "3" }, { hold: ["one_side"] }).id).group).toBe("look");
    expect(group(scanned({ player: "A Three", cardNumber: "4" }, { hold: ["error_check"] }).id).reasons).toEqual(["May be a known error version"]);
    expect(group(scanned({ player: "A Four", cardNumber: "5" }).id, ["Year"])).toMatchObject({ group: "look", reasons: ["The catalog says something else for: Year"] });
    expect(group(scanned({ player: "A Five", cardNumber: "6", rookieState: "disputed" }).id).reasons).toEqual(["The rookie mark is in doubt"]);
  });

  it("the same card scanned twice and both in Review: each needs a look, as a maybe", () => {
    const a = scanned();
    const b = scanned();
    expect(group(a.id)).toMatchObject({ group: "look", reasons: ["May be the same card as one also in Review: Card"] });
    expect(group(b.id).group).toBe("look");
    expect(findDuplicateMatches(a.id, db).map((m) => m.kind)).toEqual(["maybe"]);
  });

  it("a card you already have: needs a look", () => {
    db.insert(items).values({ kind: "card", status: "confirmed", title: "Owned", ...griffey }).run();
    expect(group(scanned().id).reasons).toEqual(["May be a card you already have: Owned"]);
  });

  it("could not read: no player and no number", () => {
    expect(group(scanned({ player: null, cardNumber: null }).id)).toMatchObject({ group: "unread" });
    // Only the number read is still a card to look at.
    expect(group(scanned({ player: null, cardNumber: "77" }).id)).toMatchObject({ group: "look", reasons: ["Blank: Player"] });
  });

  it("sealed products and lots always need a look", () => {
    const box = db.insert(items).values({ kind: "sealed", status: "needs_review", title: "Box", year: 1990, brand: "Topps" }).returning().get();
    expect(group(box.id)).toMatchObject({ group: "look", check: [] });
  });
});

describe("Confirm selected", () => {
  it("confirms only the chosen items, keeps every value as read, clears their marks only; one Undo puts it all back", () => {
    const a = scanned({ player: "Player A", cardNumber: "10" }, { unsure: ["year", "brand"] });
    const b = scanned({ player: "Player B", cardNumber: "11" }, { unsure: ["player"] });
    const c = scanned({ player: "Player C", cardNumber: "12" }, { unsure: ["year"] });
    const owned = db.insert(items).values({ kind: "card", status: "confirmed", title: "Other", player: "X" }).returning().get();

    const r = confirmFromReview([a.id, b.id, owned.id, 9999], db, new Date(5000));
    expect(r).toMatchObject({ changed: 2, summary: "Confirmed 2 items from Review" });
    const row = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
    for (const x of [a, b]) {
      expect(row(x.id)).toMatchObject({ status: "confirmed", year: 1989, brand: "Upper Deck", player: x.player, cardNumber: x.cardNumber, catalogCandidates: null });
      expect(fieldsToCheck(row(x.id))).toEqual([]);
    }
    expect(parseFieldSources(row(a.id).fieldSources)).toMatchObject({ year: "owner", brand: "owner", player: "reading", cardNumber: "reading" });
    // Not chosen: still in Review with its mark.
    expect(row(c.id)).toMatchObject({ status: "needs_review" });
    expect(fieldsToCheck(row(c.id))).toEqual(["year"]);
    expect(row(owned.id).updatedAt).toEqual(owned.updatedAt);

    const op = latestUndoable(db, new Date(6000))!;
    expect(op).toMatchObject({ summary: "Confirmed 2 items from Review", itemCount: 2, action: "status" });
    expect(undoBulk(op.id, db, new Date(6000))).toMatchObject({ restored: 2, skipped: 0 });
    expect(row(a.id)).toMatchObject({ status: "needs_review", fieldSources: a.fieldSources, catalogCandidates: a.catalogCandidates, updatedAt: a.updatedAt });
    expect(row(b.id)).toMatchObject({ status: "needs_review", fieldSources: b.fieldSources });
    expect(fieldsToCheck(row(a.id))).toEqual(["year", "brand"]);
    expect(db.select().from(bulkOps).get()!.undoneAt).toEqual(new Date(6000));
  });

  it("an item edited after the confirm is left as the owner left it by Undo", () => {
    const a = scanned({}, { unsure: ["year"] });
    const b = scanned({ player: "Other", cardNumber: "9" });
    const r = confirmFromReview([a.id, b.id], db, new Date(5000));
    if ("error" in r) throw new Error(r.error);
    db.update(items).set({ team: "Mariners", updatedAt: new Date(7000) }).where(eq(items.id, a.id)).run();
    expect(undoBulk(r.opId, db, new Date(8000))).toMatchObject({ restored: 1, skipped: 1 });
    expect(db.select().from(items).where(eq(items.id, a.id)).get()).toMatchObject({ status: "confirmed", team: "Mariners" });
  });

  it("refuses an empty or too long list, and items no longer in Review", () => {
    expect(confirmFromReview([], db)).toEqual({ error: "Select at least one item first." });
    expect(confirmFromReview(Array.from({ length: 501 }, (_, i) => i + 1), db)).toMatchObject({ error: expect.stringContaining("500") });
    const owned = db.insert(items).values({ kind: "card", status: "confirmed", title: "Owned" }).returning().get();
    expect(confirmFromReview([owned.id], db)).toEqual({ error: "These are no longer waiting in Review." });
    expect(db.select().from(bulkOps).all()).toHaveLength(0);
  });
});

const withList = (id: number, status: "candidates" | "none" | "not_checked", itemsList: object[] = []) =>
  db.update(items).set({ catalogCandidates: JSON.stringify({ v: 1, at: Date.now(), status, reason: status === "not_checked" ? "off" : null, items: itemsList }) }).where(eq(items.id, id)).run();
const choice = { source: "mycardfolio", sourceId: "s1", url: "https://example.test/c/1", sourceSetId: null, verified: true, sport: "baseball", year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr." };
const groupOf = (id: number) => {
  const item = db.select().from(items).where(eq(items.id, id)).get()!;
  return reviewGroupOf(item, groupingFactsFor(item, db));
};

describe("Open catalog list", () => {
  it("an open list is not ready and says why; nothing found, not checked or no list stay ready", () => {
    const a = scanned();
    withList(a.id, "candidates", [choice]);
    expect(groupOf(a.id)).toMatchObject({ group: "look", reasons: [PICK_CATALOG_REASON] });
    expect(PICK_CATALOG_REASON).toBe("Pick the matching catalog card");
    for (const status of ["none", "not_checked"] as const) {
      const b = scanned({ player: `P ${status}`, cardNumber: status === "none" ? "5" : "6" });
      withList(b.id, status);
      expect(groupOf(b.id).group).toBe("ready");
    }
    const c = scanned({ player: "No list", cardNumber: "7" });
    db.update(items).set({ catalogCandidates: null }).where(eq(items.id, c.id)).run();
    expect(groupOf(c.id).group).toBe("ready");
  });

  it("an empty candidates list reads as nothing found", () => {
    const a = scanned();
    withList(a.id, "candidates", []);
    expect(groupOf(a.id).group).toBe("ready");
  });

  it("the picker test: only status candidates with choices", () => {
    expect(catalogPickOpen(null)).toBe(false);
    expect(catalogPickOpen({ status: "none", candidates: [] })).toBe(false);
    expect(catalogPickOpen({ status: "candidates", candidates: [{}] })).toBe(true);
  });

  it("a dismissed list (cleared) and a linked item are not open", () => {
    const a = scanned();
    db.update(items).set({ catalogCandidates: JSON.stringify({ v: 1, at: Date.now(), status: "candidates", reason: null, items: [choice] }) }).where(eq(items.id, a.id)).run();
    db.update(items).set({ catalogCandidates: null }).where(eq(items.id, a.id)).run();
    expect(groupOf(a.id).reasons).not.toContain(PICK_CATALOG_REASON);
  });
});

describe("Confirm selected only confirms ready cards", () => {
  it("skips cards that are not ready and counts them; all skipped is a plain error with no change", () => {
    const ok = scanned({ player: "Ready One", cardNumber: "20" });
    const blank = scanned({ player: "Blank One", cardNumber: "21", brand: null });
    const open = scanned({ player: "Open One", cardNumber: "22" });
    withList(open.id, "candidates", [choice]);
    const r = confirmFromReview([ok.id, blank.id, open.id], db, new Date(5000));
    expect(r).toMatchObject({ changed: 1, skipped: 2 });
    const st = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!.status;
    expect([st(ok.id), st(blank.id), st(open.id)]).toEqual(["confirmed", "needs_review", "needs_review"]);
    expect(confirmFromReview([blank.id, open.id], db, new Date(6000))).toMatchObject({ error: expect.stringContaining("ready") });
    expect(db.select().from(bulkOps).all()).toHaveLength(1);
  });
});

describe("Delete selected from Review", () => {
  it("deletes only items still in Review and skips the rest; marks the change as made from Review", () => {
    const a = scanned({ player: "Del A", cardNumber: "30" });
    const b = scanned({ player: "Del B", cardNumber: "31" });
    db.update(items).set({ status: "confirmed" }).where(eq(items.id, b.id)).run();
    const r = applyBulk({ ids: [a.id, b.id] }, { type: "delete" }, db, new Date(5000), { fromReview: true });
    expect(r).toMatchObject({ changed: 1, skipped: 1 });
    const row = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
    expect(row(a.id).deletedAt).not.toBeNull();
    expect(row(b.id).deletedAt).toBeNull();
    expect(latest(db, new Date(6000))).toMatchObject({ action: "delete", itemCount: 1, from: "review" });
    const none = applyBulk({ ids: [b.id] }, { type: "delete" }, db, new Date(7000), { fromReview: true });
    expect(none).toEqual({ error: "These are no longer waiting in Review." });
  });
});

describe("Which changes Review offers to undo", () => {
  it("a Review change is marked; a Manage change is not", () => {
    const a = scanned({ player: "M A", cardNumber: "40" });
    const b = scanned({ player: "M B", cardNumber: "41" });
    applyBulk({ ids: [a.id] }, { type: "set", field: "team", value: "Mariners", onlyEmpty: false }, db, new Date(5000));
    expect(latest(db, new Date(6000))?.from).toBeNull();
    confirmFromReview([b.id], db, new Date(7000));
    expect(latest(db, new Date(8000))?.from).toBe("review");
  });
});
