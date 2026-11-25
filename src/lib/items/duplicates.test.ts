import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { bulkOps, catalogCards, images, items, valuations, type NewItem } from "@/db/schema";
import { applyBulk } from "./bulk";
import { duplicateIds, findDuplicateMatches, findDuplicates, keepApart, MAX_KEPT_APART, MAX_QUANTITY, mergeInto, reviewCount } from "./duplicates";

const catalogCard = { canonicalKey: "v1|griffey", sport: "baseball", year: 1989, brand: "Upper Deck", setName: "Base", cardNumber: "1", player: "Ken Griffey Jr." } as const;

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const card: Partial<NewItem> = { year: 1989, brand: "Upper Deck", setName: "Base", cardNumber: "1", player: "Ken Griffey Jr." };
function add(over: Partial<NewItem> = {}): number {
  return db.insert(items).values({ kind: "card", title: "T", status: "confirmed", ...card, ...over }).returning({ id: items.id }).get().id;
}
const ids = (id: number) => findDuplicates(id, db).map((i) => i.id);
const kinds = (id: number) => findDuplicateMatches(id, db).map((m) => [m.item.id, m.kind]);
const row = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;

describe("findDuplicates", () => {
  it("the same player and number with a blank year or brand is a maybe; a real contradiction is not (review fix 9)", () => {
    const mills = { sport: "other", year: 1991, brand: "Impel", setName: null, cardNumber: "24", player: "Billy Mills" } as const;
    const full = add(mills);
    const blank = add({ ...mills, status: "needs_review", year: null, brand: null });
    add({ ...mills, cardNumber: "25" });
    add({ ...mills, player: "Bob Mills" });
    expect(kinds(blank)).toEqual([[full, "maybe"]]);
    expect(duplicateIds(db)).toEqual([blank]);
    // A year read on one and another year on the other contradict; so do two brands.
    // (Only the other copies still in Review, with blanks where these differ, are asked about as a maybe.)
    const year92 = add({ ...mills, status: "needs_review", year: 1992, brand: null });
    expect(kinds(year92)).toEqual([[blank, "maybe"]]);
    const topps = add({ ...mills, status: "needs_review", year: null, brand: "Topps" });
    expect(kinds(topps)).toEqual([[blank, "maybe"], [year92, "maybe"]]);
    // Never combined by itself: a maybe is a question.
    expect(mergeInto(blank, full, db)).toMatchObject({ ok: false, problem: "maybe" });
  });

  it("matches ignoring case and whitespace", () => {
    const a = add({ status: "needs_review", player: " ken GRIFFEY jr. ", brand: "upper deck " });
    const b = add();
    expect(ids(a)).toEqual([b]);
  });

  it("does not match a different number; an open version or one empty grade is only a maybe", () => {
    const a = add({ status: "needs_review" });
    add({ cardNumber: "2" });
    const tiffany = add({ variation: "Tiffany" });
    const graded = add({ grader: "PSA", grade: "9" });
    expect(kinds(a)).toEqual([[tiffany, "maybe"], [graded, "maybe"]]);
  });

  it("matches the same grade", () => {
    const a = add({ status: "needs_review", grader: "psa", grade: "9" });
    const b = add({ grader: "PSA", grade: "9" });
    expect(ids(a)).toEqual([b]);
  });

  it("two items both still in Review are asked as a maybe (the same card scanned twice), never combined", () => {
    const a = add({ status: "needs_review" });
    const b = add({ status: "needs_review" });
    expect(kinds(a)).toEqual([[b, "maybe"]]);
    expect(kinds(b)).toEqual([[a, "maybe"]]);
    expect(duplicateIds(db)).toEqual([a, b]);
    expect(mergeInto(b, a, db)).toMatchObject({ ok: false, problem: "maybe" });
    expect(db.select().from(items).all()).toHaveLength(2);
  });

  it("a confirmed item is not compared with one in Review; the one in Review sees the confirmed one first", () => {
    const owned = add();
    const first = add({ status: "needs_review" });
    const second = add({ status: "needs_review" });
    expect(ids(owned)).toEqual([]);
    expect(kinds(first)).toEqual([[owned, "same"], [second, "maybe"]]);
    expect(kinds(second)).toEqual([[owned, "same"], [first, "maybe"]]);
  });

  it("never matches blank unidentified items", () => {
    const a = add({ status: "needs_review", year: null, brand: null, setName: null, cardNumber: null, player: null });
    add({ year: null, brand: null, setName: null, cardNumber: null, player: null });
    expect(ids(a)).toEqual([]);
  });

  it("matches sealed products and never bulk", () => {
    const sealed = { kind: "sealed", year: 1990, brand: "Topps", setName: "Series 1", sport: "baseball", productType: "box" } as const;
    const a = add({ ...sealed, status: "needs_review" });
    const b = add(sealed);
    add({ ...sealed, productType: "pack" });
    expect(ids(a)).toEqual([b]);
    const l1 = add({ kind: "bulk", status: "needs_review" });
    add({ kind: "bulk" });
    expect(ids(l1)).toEqual([]);
  });
});

describe("mergeInto", () => {
  it("adds quantities, moves the source's photos to the target and removes the source", () => {
    const target = add({ quantity: 3 });
    const source = add({ status: "needs_review", quantity: 2 });
    db.insert(images).values({ itemId: target, role: "front", file: "t.jpg", thumbFile: "t-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(images).values({ itemId: source, role: "front", file: "a.jpg", thumbFile: "a-t.jpg", originalFile: "a-o.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(images).values({ itemId: source, role: "back", file: "b.jpg", thumbFile: "b-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(valuations).values({ itemId: source, source: "manual", valueCents: 100 }).run();
    const r = mergeInto(source, target, db);
    expect(r).toEqual({ ok: true, targetId: target, movedPhotos: 2 });
    expect(row(target).quantity).toBe(5);
    expect(db.select().from(items).where(eq(items.id, source)).get()).toBeUndefined();
    // Every photo is still there, with its original, now on the kept record.
    expect(db.select({ itemId: images.itemId, file: images.file, originalFile: images.originalFile }).from(images).all()).toEqual([
      { itemId: target, file: "t.jpg", originalFile: null },
      { itemId: target, file: "a.jpg", originalFile: "a-o.jpg" },
      { itemId: target, file: "b.jpg", originalFile: null },
    ]);
    expect(db.select().from(valuations).all()).toHaveLength(0);
  });

  it("refuses non-duplicates, self and missing items", () => {
    const a = add({ status: "needs_review" });
    const b = add({ cardNumber: "9" });
    expect(mergeInto(a, b, db)).toMatchObject({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, a, db)).toMatchObject({ ok: false, error: "These are not the same card." });
    expect(mergeInto(a, 9999, db)).toMatchObject({ ok: false, error: "That item no longer exists." });
    expect(db.select().from(items).all()).toHaveLength(2);
  });

  it("refuses to go above the form's maximum and changes nothing", () => {
    const source = add({ status: "needs_review", quantity: 2 });
    const target = add({ quantity: MAX_QUANTITY - 1 });
    const r = mergeInto(source, target, db);
    expect(r).toMatchObject({ ok: false, problem: "too_many" });
    if (!r.ok) expect(r.error).toMatch(/100,000/);
    expect(db.select().from(items).where(eq(items.id, target)).get()?.quantity).toBe(MAX_QUANTITY - 1);
    expect(db.select().from(items).all()).toHaveLength(2);
    // Exactly the maximum is fine.
    const s2 = add({ status: "needs_review", quantity: 1 });
    expect(mergeInto(s2, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()?.quantity).toBe(MAX_QUANTITY);
  });

  it("keeps the source's value and history when the target has none", () => {
    const target = add();
    const source = add({ status: "needs_review", estLowCents: 400, estHighCents: 800, estValueCents: 600, valueSource: "ai_estimate", valueBasis: "AI." });
    db.insert(valuations).values({ itemId: source, source: "ai_estimate", valueCents: 600 }).run();
    expect(mergeInto(source, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()).toMatchObject({
      estLowCents: 400, estHighCents: 800, estValueCents: 600, valueSource: "ai_estimate", valueBasis: "AI.", quantity: 2,
    });
    expect(db.select().from(valuations).all()).toMatchObject([{ itemId: target, valueCents: 600 }]);
  });

  it("keeps the target's own value when it has one", () => {
    const target = add({ manualValueCents: 100 });
    const source = add({ status: "needs_review", estValueCents: 600 });
    expect(mergeInto(source, target, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, target)).get()).toMatchObject({ manualValueCents: 100, estValueCents: null });
  });
});

describe("reviewCount", () => {
  it("counts items waiting", () => {
    expect(reviewCount(db)).toBe(0);
    add({ status: "needs_review" });
    add();
    expect(reviewCount(db)).toBe(1);
  });
});

describe("merge and bulk undo", () => {
  it("scrubs the merged-away item from saved undo entries", () => {
    const a = add();
    const b = add();
    const c = add({ cardNumber: "9" });
    const r = applyBulk({ ids: [a, b, c] }, { type: "set", field: "notes", value: "secret", onlyEmpty: false, clear: false }, db);
    expect("error" in r).toBe(false);
    expect(mergeInto(b, a, db).ok).toBe(true);
    const undo = JSON.parse(db.select().from(bulkOps).all()[0].undo) as { items: number[][] };
    expect(undo.items.map((e) => e[0]).sort()).toEqual([a, c].sort());
    expect(db.select().from(bulkOps).all()[0].undo).not.toContain('"' + b + '"');
  });
});

describe("duplicate kinds (Milestone 11)", () => {
  const confirmed = { versionState: "confirmed", versionSource: "owner" } as const;

  it("the same catalog card twice is same, even spelled differently", () => {
    const cat = db.insert(catalogCards).values(catalogCard).returning({ id: catalogCards.id }).get().id;
    const a = add({ status: "needs_review", catalogCardId: cat, brand: "UD", player: "Griffey" });
    const b = add({ catalogCardId: cat });
    expect(kinds(a)).toEqual([[b, "same"]]);
    // Two different catalog cards are never duplicates, whatever the fields say.
    const other = db.insert(catalogCards).values({ ...catalogCard, cardNumber: "2", canonicalKey: "v1|other" }).returning({ id: catalogCards.id }).get().id;
    const c = add({ status: "needs_review", catalogCardId: other });
    expect(kinds(c)).toEqual([]);
  });

  it("names meet through the normalize functions", () => {
    const a = add({ status: "needs_review", player: "Ken Griffey Jr", brand: "upper-deck" });
    const b = add();
    expect(kinds(a)).toEqual([[b, "same"]]);
  });

  it("base and Tiffany are not duplicates", () => {
    const base = add({ status: "needs_review", ...confirmed, variation: null });
    add({ ...confirmed, variation: "Tiffany" });
    add({ variation: "Tiffany" });
    expect(kinds(base)).toEqual([]);
  });

  it("a confirmed base and a not sure copy are maybe and cannot merge", () => {
    const base = add({ ...confirmed, variation: null });
    const open = add({ status: "needs_review", versionState: "not_sure", versionSource: "owner" });
    expect(kinds(open)).toEqual([[base, "maybe"]]);
    expect(mergeInto(open, base, db)).toMatchObject({ ok: false, problem: "maybe" });
    expect(db.select().from(items).all()).toHaveLength(2);
    expect(row(base).quantity).toBe(1);
  });

  it("PSA 9 and PSA 10 are not duplicates", () => {
    const a = add({ status: "needs_review", grader: "PSA", grade: "9" });
    add({ grader: "PSA", grade: "10" });
    expect(kinds(a)).toEqual([]);
  });

  it("045/100 and 046/100 never merge by any path", () => {
    const a = add({ status: "needs_review", serialCopy: "045", serialEdition: "100", serialNumber: "045/100" });
    const b = add({ serialCopy: "046", serialEdition: "100", serialNumber: "046/100" });
    // An old record with only the whole text counts too.
    const c = add({ serialNumber: "46/100" });
    expect(kinds(a)).toEqual([]);
    expect(duplicateIds(db)).not.toContain(a);
    // A hand made form post names the pair directly: still refused, nothing changes.
    expect(mergeInto(a, b, db)).toMatchObject({ ok: false, problem: "not_same" });
    expect(mergeInto(a, c, db)).toMatchObject({ ok: false, problem: "not_same" });
    db.update(items).set({ status: "confirmed" }).where(eq(items.id, a)).run();
    expect(mergeInto(b, a, db)).toMatchObject({ ok: false, problem: "not_same" });
    expect(db.select().from(items).all()).toHaveLength(3);
  });

  it("the same copy twice is same_numbered and the merge does not raise the quantity", () => {
    const old = add({ serialCopy: "045", serialEdition: "100", serialNumber: "045/100", quantity: 1 });
    const again = add({ status: "needs_review", serialNumber: "45/100", quantity: 1 });
    db.insert(images).values({ itemId: again, role: "back", file: "n.jpg", thumbFile: "n-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    expect(kinds(again)).toEqual([[old, "same_numbered"]]);
    expect(mergeInto(again, old, db)).toEqual({ ok: true, targetId: old, movedPhotos: 1 });
    expect(row(old).quantity).toBe(1);
    expect(db.select().from(images).all()).toMatchObject([{ itemId: old, file: "n.jpg" }]);
  });

  it("a serial copy on one side only is a maybe", () => {
    const old = add({ serialCopy: "045", serialEdition: "100", serialNumber: "045/100" });
    const plain = add({ status: "needs_review" });
    expect(kinds(plain)).toEqual([[old, "maybe"]]);
    expect(mergeInto(plain, old, db)).toMatchObject({ ok: false, problem: "maybe" });
  });

  it("kept apart pairs are written on both sides and not asked again", () => {
    const a = add();
    const b = add({ status: "needs_review" });
    expect(duplicateIds(db)).toEqual([b]);
    expect(keepApart(b, a, db)).toEqual({ ok: true });
    expect(JSON.parse(row(a).keptApartFrom!)).toEqual([b]);
    expect(JSON.parse(row(b).keptApartFrom!)).toEqual([a]);
    expect(kinds(b)).toEqual([]);
    expect(kinds(a)).toEqual([]);
    expect(duplicateIds(db)).toEqual([]);
    expect(mergeInto(b, a, db)).toMatchObject({ ok: false, problem: "not_same" });
    // Twice is fine and writes nothing new.
    expect(keepApart(a, b, db)).toEqual({ ok: true });
    expect(JSON.parse(row(a).keptApartFrom!)).toEqual([b]);
    // A third copy is still asked about.
    const c = add({ status: "needs_review" });
    // The confirmed one first, then the other copy still in Review.
    expect(kinds(c)).toEqual([[a, "same"], [b, "maybe"]]);
  });

  it("keep apart refuses a pair that is not a question, and keeps at most the newest ids", () => {
    const a = add();
    const other = add({ cardNumber: "77" });
    expect(keepApart(a, other, db)).toMatchObject({ ok: false });
    expect(keepApart(a, a, db)).toMatchObject({ ok: false });
    expect(row(a).keptApartFrom).toBeNull();
    const full = Array.from({ length: MAX_KEPT_APART }, (_, i) => 10_000 + i);
    db.update(items).set({ keptApartFrom: JSON.stringify(full) }).where(eq(items.id, a)).run();
    const b = add();
    expect(keepApart(a, b, db)).toEqual({ ok: true });
    const list = JSON.parse(row(a).keptApartFrom!) as number[];
    expect(list).toHaveLength(MAX_KEPT_APART);
    expect(list.at(-1)).toBe(b);
  });

  it("a merge keeps the target's value, version and rookie answers", () => {
    const target = add({
      ...confirmed, variation: "Tiffany", manualValueCents: 5000, rookieState: "yes", rookieSource: "owner", isRookie: true,
      notes: "mine",
    });
    const source = add({
      status: "needs_review", ...confirmed, variation: "tiffany", manualValueCents: 100, rookieState: "no", rookieSource: "owner",
      isRookie: false, notes: "other",
    });
    expect(mergeInto(source, target, db).ok).toBe(true);
    expect(row(target)).toMatchObject({
      quantity: 2, manualValueCents: 5000, variation: "Tiffany", versionState: "confirmed", rookieState: "yes", isRookie: true, notes: "mine",
    });
  });

  it("the duplicate filter on 5,000 items runs in under 200 ms", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      kind: "card" as const, title: "T", status: "confirmed" as const, year: 1980 + (i % 20), brand: "Topps",
      cardNumber: String(i % 300), player: `Player ${i % 300}`, variation: i % 7 === 0 ? "Gold" : null,
    }));
    for (let i = 0; i < rows.length; i += 500) db.insert(items).values(rows.slice(i, i + 500)).run();
    // Best of three runs: the whole test suite runs in parallel on the same machine.
    let best = Infinity;
    let found: number[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      found = duplicateIds(db);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(2000); // loose for a busy server; about 100 ms when quiet
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("mergeInto keeps the older record", () => {
  it("combines the newer into the older whichever way it is asked", () => {
    const older = add({ quantity: 2 });
    const newer = add({ quantity: 3 });
    db.insert(images).values({ itemId: older, role: "front", file: "o.jpg", thumbFile: "o-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(images).values({ itemId: newer, role: "front", file: "n.jpg", thumbFile: "n-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    // Started from the OLDER page: the "source" is the older id.
    const r = mergeInto(older, newer, db);
    expect(r).toEqual({ ok: true, targetId: older, movedPhotos: 1 });
    expect(db.select().from(items).where(eq(items.id, newer)).get()).toBeUndefined();
    expect(row(older).quantity).toBe(5);
    expect(db.select().from(images).all().map((i) => [i.itemId, i.file])).toEqual([[older, "o.jpg"], [older, "n.jpg"]]);
  });

  it("takes the newer one's answers only where the older has none", () => {
    const older = add({ notes: "older note", rookieState: "no", rookieSource: "owner", isRookie: false, manualValueCents: 500 });
    const newer = add({ notes: "newer note", rookieState: "yes", rookieSource: "owner", isRookie: true, manualValueCents: 900, variation: "Tiffany", versionState: "confirmed", versionSource: "owner" });
    // Same kind needs equal versions; make both agree by asking with equal version fields.
    db.update(items).set({ variation: "Tiffany", versionState: "confirmed", versionSource: "owner" }).where(eq(items.id, older)).run();
    expect(mergeInto(newer, older, db).ok).toBe(true);
    expect(row(older)).toMatchObject({ notes: "older note", rookieState: "no", isRookie: false, manualValueCents: 500 });

    const o2 = add({ notes: " ", manualValueCents: null });
    const n2 = add({ notes: "from newer", rookieState: "yes", rookieSource: "owner", isRookie: true, manualValueCents: 900, estValueCents: 700 });
    expect(mergeInto(o2, n2, db).ok).toBe(true);
    expect(row(o2)).toMatchObject({ notes: "from newer", rookieState: "yes", isRookie: true, rookieSource: "owner", manualValueCents: 900 });
  });
});
