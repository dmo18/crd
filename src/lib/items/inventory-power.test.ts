import { beforeEach, describe, expect, it } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { items, type NewItem } from "@/db/schema";
import { exportPick } from "@/lib/export/select";
import { collectionTotals } from "@/lib/valuation/snapshots";
import { applyBulk, parseAction, undoBulk, previewBulk } from "./bulk";
import { duplicateIds } from "./duplicates";
import { setOutcome } from "./outcome";
import { countFilters, inventoryFilterSchema, listItems, matchingIds } from "./query";
import { BREAKDOWN_TOP, breakdownBy, goneCount, gradedSplit, highlights, kindBreakdown } from "./stats";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
});

const add = (over: Partial<NewItem> & { title: string }) => db.insert(items).values({ kind: "card", ...over }).returning({ id: items.id }).get().id;
const parse = (p: Record<string, string>) => inventoryFilterSchema.parse(p);
const titles = (p: Record<string, string>) => listItems(parse(p), db).rows.map((r) => r.title).sort();

function seed() {
  add({ title: "Auto", isAutograph: true, estValueCents: 5000 });
  add({ title: "Relic", isMemorabilia: true, estValueCents: 1000 });
  add({ title: "Numbered", serialNumber: "045/100", variation: "Gold Refractor", isParallel: true, manualValueCents: 20000 });
  add({ title: "Graded", grader: "PSA", grade: "10", estValueCents: 30000 });
  add({ title: "Graded9", grader: "psa", grade: "9", estValueCents: 4000 });
  add({ title: "Pair", quantity: 2, estValueCents: 300 });
  add({ title: "NoPrice" });
  add({ title: "Err", isError: true, isInsert: true, estValueCents: 700 });
}

describe("more filters", () => {
  beforeEach(seed);
  it("marks", () => {
    expect(titles({ autograph: "1" })).toEqual(["Auto"]);
    expect(titles({ relic: "1" })).toEqual(["Relic"]);
    expect(titles({ serial: "1" })).toEqual(["Numbered"]);
    expect(titles({ parallel: "1" })).toEqual(["Numbered"]);
    expect(titles({ error: "1" })).toEqual(["Err"]);
    expect(titles({ insert: "1" })).toEqual(["Err"]);
    expect(titles({ multi: "1" })).toEqual(["Pair"]);
  });
  it("version, grader and grade ignore capitals", () => {
    expect(titles({ variation: "refractor" })).toEqual(["Numbered"]);
    expect(titles({ grader: "PSA" })).toEqual(["Graded", "Graded9"]);
    expect(titles({ grader: "PSA", grade: "10" })).toEqual(["Graded"]);
  });
  it("graded against raw", () => {
    expect(titles({ grading: "graded" })).toEqual(["Graded", "Graded9"]);
    expect(titles({ grading: "raw" })).toHaveLength(6);
  });
  it("value range is per unit and never matches an item with no price", () => {
    expect(titles({ minValue: "50" })).toEqual(["Auto", "Graded", "Numbered"]);
    expect(titles({ minValue: "10", maxValue: "50" })).toEqual(["Auto", "Graded9", "Relic"]);
    expect(titles({ maxValue: "3" })).toEqual(["Pair"]);
  });
  it("no price", () => expect(titles({ value: "none" })).toEqual(["NoPrice"]));
  it("exact player, team and set", () => {
    add({ title: "P", player: "Ken Griffey Jr.", team: "Mariners", setName: "Base" });
    expect(titles({ player: " ken griffey jr. " })).toEqual(["P"]);
    expect(titles({ team: "mariners", set: "base" })).toEqual(["P"]);
    expect(titles({ player: "Ken" })).toEqual([]);
  });
  it("bad values count as not set, and active filters are counted", () => {
    const f = parse({ minValue: "abc", autograph: "yes", grader: " ", grading: "x" });
    expect(f).toEqual({ sort: "newest", page: 1 });
    // Dollars are read safely: no sign, no exponent, no NaN, at most 9,999,999.99.
    for (const v of ["-5", "1e3", "NaN", "Infinity", "10000000", "5.555", ""]) expect(parse({ minValue: v, maxValue: v })).toEqual({ sort: "newest", page: 1 });
    expect(parse({ minValue: "9999999.99", maxValue: "0" })).toMatchObject({ minValue: 9999999.99, maxValue: 0 });
    expect(titles({ minValue: "3.00", maxValue: "3" })).toEqual(["Pair"]);
    expect(countFilters(parse({ autograph: "1", grader: "PSA", minValue: "5", q: "x", sort: "player" }))).toBe(3);
  });
  it("filters combine with each other", () => {
    expect(titles({ grader: "PSA", minValue: "100" })).toEqual(["Graded"]);
  });
});

describe("export follows the new filters", () => {
  beforeEach(seed);
  const exported = (q: string) => {
    const r = exportPick(new URLSearchParams(q), db);
    if ("error" in r) throw new Error(r.error);
    return r.rows.map((x) => x.title).sort();
  };
  it("covers exactly what the list shows", () => {
    for (const q of ["autograph=1", "grading=graded", "minValue=50&maxValue=250", "multi=1", "value=none", "grader=PSA&grade=9", "variation=gold"]) {
      const shown = listItems(parse(Object.fromEntries(new URLSearchParams(q))), db).rows.map((r) => r.title).sort();
      expect(exported(q), q).toEqual(shown);
      expect(shown.length, q).toBeGreaterThan(0);
    }
  });
});

describe("sold and removed", () => {
  it("are kept out of every total, count, duplicate check and the default list", () => {
    const a = add({ title: "A", player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", estValueCents: 1000, quantity: 2, status: "needs_review", isRookie: true });
    const b = add({ title: "A2", player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", estValueCents: 1000 });
    add({ title: "Other", estValueCents: 500 });
    expect(duplicateIds(db).sort()).toEqual([a, b]);
    expect(highlights(db)).toMatchObject({ needsReview: 3, rookies: 1 });
    const before = collectionTotals(db);
    expect(before).toMatchObject({ itemCount: 3, unitCount: 4, totalValueCents: 3500 });
    const r = setOutcome({ id: a, outcome: "sold", price: "$25.50", date: "2026-11-20" }, db);
    expect(r).toMatchObject({ ok: true });
    expect(collectionTotals(db)).toMatchObject({ itemCount: 2, unitCount: 2, totalValueCents: 1500 });
    expect(duplicateIds(db)).toEqual([]);
    expect(kindBreakdown(db)[0]).toMatchObject({ rows: 2, units: 2, valueCents: 1500 });
    expect(highlights(db)).toMatchObject({ needsReview: 2, rookies: 0 });
    expect(listItems(parse({}), db).rows.map((x) => x.id).sort()).not.toContain(a);
    expect(listItems(parse({}), db).totalValueCents).toBe(1500);
    expect(breakdownBy("player", 10, db)).toEqual([{ label: "Ken Griffey Jr.", units: 1, valueCents: 1000 }]);
    const sold = db.select().from(items).all().find((x) => x.id === a)!;
    expect(sold).toMatchObject({ status: "sold", soldPriceCents: 2550, statusBefore: "needs_review" });
    expect(sold.soldAt?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    // Shown only under the Sold and removed filter.
    expect(listItems(parse({ status: "gone" }), db).rows.map((x) => x.id)).toEqual([a]);
    expect(listItems(parse({ status: "sold" }), db).rows.map((x) => x.id)).toEqual([a]);
    expect(listItems(parse({ status: "removed" }), db).total).toBe(0);
    expect(goneCount(db)).toBe(1);
  });

  it("removed has no sale details, and Back in my collection restores the old status and clears them", () => {
    const a = add({ title: "A", status: "needs_review", estValueCents: 100 });
    expect(setOutcome({ id: a, outcome: "removed", price: "5", date: "2026-01-01" }, db)).toMatchObject({ ok: true });
    expect(db.select().from(items).get()).toMatchObject({ status: "removed", soldPriceCents: null, soldAt: null });
    expect(setOutcome({ id: a, outcome: "removed" }, db)).toMatchObject({ ok: false });
    expect(setOutcome({ id: a, outcome: "back" }, db)).toMatchObject({ ok: true });
    expect(db.select().from(items).get()).toMatchObject({ status: "needs_review", statusBefore: null });
    expect(collectionTotals(db).itemCount).toBe(1);
    expect(setOutcome({ id: a, outcome: "back" }, db)).toMatchObject({ ok: false });
  });

  it("checks the price and the date", () => {
    const a = add({ title: "A" });
    expect(setOutcome({ id: a, outcome: "sold", price: "twelve" }, db)).toEqual({ ok: false, error: "Type the price in dollars, like 12.50." });
    expect(setOutcome({ id: a, outcome: "sold", date: "yesterday" }, db)).toMatchObject({ ok: false });
    expect(setOutcome({ id: a, outcome: "nope" }, db)).toMatchObject({ ok: false });
    expect(parseAction({ type: "outcome", outcome: "sold", soldPriceCents: -1, soldDate: null })).toHaveProperty("error");
    expect(parseAction({ type: "outcome", outcome: "sold", soldPriceCents: 1, soldDate: "2026-02-31" })).toHaveProperty("error");
    expect(db.select().from(items).get()!.status).toBe("needs_review");
  });

  it("works from Manage with the bulk undo, for ticked items and for all matching", () => {
    const ids = [add({ title: "A", estValueCents: 100, status: "confirmed" }), add({ title: "B", estValueCents: 200, status: "needs_review" }), add({ title: "C", status: "confirmed" })];
    const act = parseAction({ type: "outcome", outcome: "sold", soldPriceCents: 1500, soldDate: "2026-11-01" });
    if ("error" in act) throw new Error(act.error);
    expect(previewBulk({ ids: [ids[0], ids[1]] }, act, db)).toMatchObject({ count: 2 });
    const res = applyBulk({ ids: [ids[0], ids[1]] }, act, db);
    if ("error" in res) throw new Error(res.error);
    expect(res).toMatchObject({ changed: 2, summary: "Marked 2 items as sold" });
    expect(collectionTotals(db).itemCount).toBe(1);
    const undo = undoBulk(res.opId, db);
    expect(undo).toMatchObject({ restored: 2 });
    const rows = db.select().from(items).all();
    expect(rows.map((r) => [r.status, r.soldPriceCents, r.soldAt, r.statusBefore])).toEqual([
      ["confirmed", null, null, null], ["needs_review", null, null, null], ["confirmed", null, null, null],
    ]);
    // Sold twice then put back with "all matching" in the sold list.
    const sold = applyBulk({ ids }, act, db);
    if ("error" in sold) throw new Error(sold.error);
    const filters = { status: "gone" as const };
    const back = applyBulk({ filters, expectedCount: 3, fingerprint: undefined }, { type: "outcome", outcome: "back" }, db);
    expect(back).toEqual({ error: "The list changed. Look again." });
    const { ids: matched } = matchingIds(filters, 10, db);
    expect(matched).toEqual(ids);
    const prev = previewBulk({ filters, expectedCount: 3 }, { type: "outcome", outcome: "back" }, db);
    if ("error" in prev) throw new Error(prev.error);
    const done = applyBulk({ filters, expectedCount: 3, fingerprint: prev.fingerprint }, { type: "outcome", outcome: "back" }, db);
    expect(done).toMatchObject({ changed: 3 });
    expect(collectionTotals(db).itemCount).toBe(3);
    // Changes other than "back" never touch a sold item.
    setOutcome({ id: ids[2], outcome: "removed" }, db);
    expect(applyBulk({ ids: [ids[2]] }, { type: "status", status: "confirmed" }, db)).toEqual({ error: "Nothing here needs this change." });
  });

  it("undo of Back in my collection brings back the sale exactly, and a sold item can go to Recently deleted and back", () => {
    const a = add({ title: "A", status: "needs_review", estValueCents: 100 });
    const t0 = new Date("2026-11-20T10:00:00Z");
    expect(setOutcome({ id: a, outcome: "sold", price: "12.50", date: "2026-11-02" }, db, t0)).toMatchObject({ ok: true });
    const sold = db.select().from(items).get()!;
    expect(sold).toMatchObject({ status: "sold", soldPriceCents: 1250, soldAt: new Date("2026-11-02T00:00:00Z"), statusBefore: "needs_review" });
    const back = applyBulk({ ids: [a] }, { type: "outcome", outcome: "back" }, db, new Date("2026-11-21T10:00:00Z"));
    if ("error" in back) throw new Error(back.error);
    expect(db.select().from(items).get()).toMatchObject({ status: "needs_review", soldPriceCents: null, soldAt: null, statusBefore: null });
    expect(undoBulk(back.opId, db, new Date("2026-11-21T11:00:00Z"))).toMatchObject({ restored: 1, skipped: 0 });
    const again = db.select().from(items).get()!;
    expect([again.status, again.soldPriceCents, again.soldAt, again.statusBefore, again.updatedAt])
      .toEqual([sold.status, sold.soldPriceCents, sold.soldAt, sold.statusBefore, sold.updatedAt]);
    // Delete from the Sold and removed list: it goes to the bin, and undo puts it back still sold.
    const del = applyBulk({ ids: [a] }, { type: "delete" }, db, new Date("2026-11-22T10:00:00Z"));
    if ("error" in del) throw new Error(del.error);
    expect(listItems(parse({ status: "gone" }), db).total).toBe(0);
    expect(undoBulk(del.opId, db, new Date("2026-11-22T11:00:00Z"))).toMatchObject({ restored: 1 });
    expect(db.select().from(items).get()).toMatchObject({ status: "sold", deletedAt: null, soldPriceCents: 1250 });
    // Only a real day is taken.
    expect(setOutcome({ id: add({ title: "B" }), outcome: "sold", date: "2026-02-31" }, db)).toEqual({ ok: false, error: "That date is not real. Pick the day again." });
  });

  it("CSV export shows the status and the sale, and the sold list can be exported", () => {
    const a = add({ title: "A", estValueCents: 100 });
    setOutcome({ id: a, outcome: "sold", price: "9.99", date: "2026-03-04" }, db);
    expect(exportPick(new URLSearchParams(), db)).toMatchObject({ what: "all", rows: [] });
    const r = exportPick(new URLSearchParams("status=gone"), db);
    expect(r).toMatchObject({ what: "filtered" });
    expect("rows" in r && r.rows.map((x) => [x.status, x.soldPriceCents])).toEqual([["sold", 999]]);
  });
});

describe("Home breakdowns", () => {
  it("group by name, use the value rule, leave out blanks and cut to the top", () => {
    add({ title: "a", sport: "baseball", player: "Ken Griffey Jr.", team: "Mariners", setName: "Base", estValueCents: 1000, quantity: 2 });
    add({ title: "b", sport: "baseball", player: " ken griffey jr. ", team: "Mariners", setName: "Base", estValueCents: 5000, manualValueCents: 100 });
    add({ title: "c", sport: "football", player: "Tom Brady", estValueCents: 3000 });
    add({ title: "d", player: "  ", sport: null });
    for (let i = 0; i < 12; i++) add({ title: `p${i}`, player: `Player ${i}`, estValueCents: i });
    expect(breakdownBy("sport", 20, db)).toEqual([
      { label: "football", units: 1, valueCents: 3000 }, { label: "baseball", units: 3, valueCents: 2100 },
    ]);
    const players = breakdownBy("player", BREAKDOWN_TOP, db);
    expect(players).toHaveLength(10);
    expect(players[0]).toEqual({ label: "Tom Brady", units: 1, valueCents: 3000 });
    expect(players[1]).toEqual({ label: "Ken Griffey Jr.", units: 3, valueCents: 2100 });
    expect(breakdownBy("team", 10, db)).toEqual([{ label: "Mariners", units: 3, valueCents: 2100 }]);
    expect(breakdownBy("set", 10, db)).toEqual([{ label: "Base", units: 3, valueCents: 2100 }]);
  });
  it("splits raw from graded with the filter rule, and counts the unpriced", () => {
    add({ title: "raw", estValueCents: 100, quantity: 2 });
    add({ title: "g", grader: "PSA", grade: "9", manualValueCents: 900 });
    add({ title: "blank grader", grader: "  ", estValueCents: 50 });
    add({ title: "sealed", kind: "sealed", estValueCents: 70 });
    add({ title: "none" });
    expect(gradedSplit(db)).toEqual({
      graded: { label: "Graded", units: 1, valueCents: 900 },
      raw: { label: "Raw", units: 4, valueCents: 250 },
    });
    expect(listItems(parse({ grading: "graded" }), db).total).toBe(1);
    expect(listItems(parse({ grading: "raw" }), db).totalUnits).toBe(4);
    expect(highlights(db).noValue).toBe(1);
    expect(listItems(parse({ value: "none" }), db).total).toBe(1);
  });
});
