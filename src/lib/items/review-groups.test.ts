import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { bulkOps, items, type NewItem } from "@/db/schema";
import { buildFirstSuggestion, fieldsToCheck, parseFieldSources, sourcesFor } from "@/lib/catalog/sources";
import { latestUndoable, undoBulk } from "./bulk";
import { findDuplicateMatches } from "./duplicates";
import { confirmFromReview } from "./review-confirm";
import { reviewGroupOf } from "./review-groups";

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
  return reviewGroupOf(item, { duplicate: findDuplicateMatches(id, db)[0] ?? null, catalogDifferences: differences });
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
