import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { bulkOps, collectionSnapshots, images, items, locations, scans, valuations, type NewItem } from "@/db/schema";
import { convertScanPhotos } from "@/lib/images/archive";
import { removeOrphanPhotos } from "@/lib/images/cleanup";
import { uploadsDir } from "@/lib/images/store";
import { listLocations } from "@/lib/locations/locations";
import { setLogSink } from "@/lib/log";
import { recognizedItemSchema, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { createScan } from "@/lib/scans/create";
import { processScan } from "@/lib/scans/process";
import { getScanView, recentScans, scanPhotoThumbs, scanStatusCounts, scanViews } from "@/lib/scans/view";
import { revalueItem } from "@/lib/valuation";
import { SampleSource } from "@/lib/valuation/sample-source";
import { collectionTotals, recordSnapshot } from "@/lib/valuation/snapshots";
import { BIN_DAYS, daysLeft, timeLeftText, maybePurgeBin, purgeExpired, purgeItems, resetBinPurge, restoreItems, softDeleteItems } from "./bin";
import { applyBulk } from "./bulk";
import { findDuplicates, mergeInto, reviewCount, reviewItems } from "./duplicates";
import { inventoryFilterSchema, listItems } from "./query";
import { setQuickValue } from "./quick-value";
import { decadeBreakdown, highlights, kindBreakdown, recentItems, topItems } from "./stats";
import { confirmItem, deleteItem, updateItem } from "./update";

// The export route checks the session and writes to the activity log; both are covered elsewhere.
vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), guardApi: async () => null }));
vi.mock("@/lib/audit/request", () => ({ auditThisRequest: async () => undefined }));
const { GET: exportCsv } = await import("@/app/api/export/route");

const DAY = 24 * 60 * 60 * 1000;
const photo = () => sharp({ create: { width: 900, height: 1200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
const exists = (f: string) => fs.access(path.join(uploadsDir(), f)).then(() => true, () => false);
const fake = (result: RecognizedItemInput[]): Recognizer => ({
  name: "fake", async recognize() { return result.map((r) => recognizedItemSchema.parse(r)); },
});
const card: RecognizedItemInput = {
  kind: "card", confidence: 0.95, sport: "baseball", year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.",
  estimate: { lowCents: 100, highCents: 300, basis: "x" },
};
const all = inventoryFilterSchema.parse({});

let db: Db;
beforeEach(() => { db = createDb(":memory:"); setDbForTests(db); });
afterEach(() => { setDbForTests(undefined); });

/** A two-card photo: two items from one scan sharing the scan's source photo. */
async function multiScan(convert = true) {
  const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
  await processScan(scanId, {
    db,
    recognizer: fake([
      { ...card, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
      { ...card, box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } },
    ]),
  });
  if (convert) expect(await convertScanPhotos(scanId, db)).toBe(3);
  const [a, b] = db.select({ id: items.id }).from(items).where(eq(items.scanId, scanId)).all().map((r) => r.id);
  return { scanId, a: a!, b: b! };
}
/** Files on disk for these photo rows (before conversion the full size one is the working copy). */
const filesOf = (where: ReturnType<typeof eq>) =>
  db.select().from(images).where(where).all().flatMap((r) => [r.thumbFile, r.workFile ? `work/${r.workFile}` : r.file]);
const insert = (over: Partial<NewItem>) => db.insert(items).values({ kind: "card", title: "T", ...over }).returning({ id: items.id }).get().id;

describe("every reader ignores an item in Recently deleted", () => {
  /*
   * Readers changed in 9.6 and checked here:
   * listItems (inventory and its totals), kindBreakdown, topItems, highlights,
   * decadeBreakdown, recentItems (home), findDuplicates, mergeInto, reviewCount,
   * reviewItems (review page), collectionTotals and recordSnapshot (chart),
   * GET /api/export, getScanView, scanViews, recentScans, scanStatusCounts
   * (scan screens), listLocations, updateItem, confirmItem, deleteItem,
   * setQuickValue, revalueItem.
   * Not filtered, on purpose: restore, purge, the item page (shows Restore),
   * itemLabel (log text), storageSummary (photos still on disk), process.ts
   * (rows it made a moment ago).
   */
  it("leaves the deleted ones out of every count, total, list and check", async () => {
    const loc = db.insert(locations).values({ name: "Box 1" }).returning({ id: locations.id }).get().id;
    const { scanId, a, b } = await multiScan(false);
    // a and b are the same card, so b is a duplicate of a.
    db.update(items).set({ status: "confirmed", locationId: loc, manualValueCents: 500, isRookie: true, rarityTier: "key" }).where(eq(items.id, a)).run();
    db.update(items).set({ status: "confirmed", locationId: loc, manualValueCents: 700, isRookie: true, rarityTier: "key" }).where(eq(items.id, b)).run();
    const c = insert({ title: "Zeta Deleted", status: "needs_review", year: 1975, manualValueCents: 900, locationId: loc, kind: "sealed" });
    expect(listItems(all, db).total).toBe(3);
    expect(findDuplicates(a, db).map((d) => d.id)).toEqual([b]);

    expect(softDeleteItems([b, c], db)).toBe(2);

    const inv = listItems(all, db);
    expect(inv.rows.map((r) => r.id)).toEqual([a]);
    expect([inv.total, inv.totalUnits, inv.totalValueCents]).toEqual([1, 1, 500]);
    expect(listItems(inventoryFilterSchema.parse({ q: "Zeta" }), db).total).toBe(0);
    expect(kindBreakdown(db)).toEqual([
      { kind: "card", rows: 1, units: 1, valueCents: 500 },
      { kind: "sealed", rows: 0, units: 0, valueCents: 0 },
      { kind: "bulk", rows: 0, units: 0, valueCents: 0 },
    ]);
    expect(topItems(10, db).map((r) => r.id)).toEqual([a]);
    expect(highlights(db)).toMatchObject({ rookies: 1, keyCards: 1, needsReview: 0 });
    expect(decadeBreakdown(db)).toEqual([{ label: "1980s", units: 1, valueCents: 500 }]);
    expect(recentItems(10, db).map((r) => r.id)).toEqual([a]);

    expect(findDuplicates(a, db)).toEqual([]);
    expect(findDuplicates(b, db)).toEqual([]);
    expect(mergeInto(b, a, db)).toMatchObject({ ok: false, problem: "gone" });
    expect(mergeInto(a, b, db)).toMatchObject({ ok: false, problem: "gone" });
    expect(reviewCount(db)).toBe(0);
    expect(reviewItems(100, db)).toEqual([]);

    expect(collectionTotals(db)).toEqual({ totalValueCents: 500, itemCount: 1, unitCount: 1 });
    recordSnapshot(db, new Date("2026-11-16T12:00:00Z"));
    // Other steps above may record a snapshot for the real day; this checks the row for the day asked for.
    expect(db.select().from(collectionSnapshots).all()).toContainEqual({ day: "2026-11-16", totalValueCents: 500, itemCount: 1, unitCount: 1 });

    const csv = await (await exportCsv(new Request("http://localhost/api/export"))).text();
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(csv).not.toContain("Zeta");

    expect(getScanView(scanId, db)!.items.map((i) => i.id)).toEqual([a]);
    expect(scanViews([scanId], db)[0]!.items.map((i) => i.id)).toEqual([a]);
    expect(recentScans(20, db)[0]!.items.map((i) => i.id)).toEqual([a]);
    expect(scanStatusCounts(db).toReview).toBe(0);
    expect(listLocations(db)).toMatchObject([{ id: loc, itemCount: 1, unitCount: 1, totalValueCents: 500 }]);

    const before = db.select().from(items).where(eq(items.id, b)).get();
    expect(updateItem(b, { quantity: "4", player: "Changed" }, db).ok).toBe(false);
    expect(confirmItem(c, db).ok).toBe(false);
    expect(deleteItem(b, db).ok).toBe(false);
    expect(setQuickValue(b, "12.00", db).ok).toBe(false);
    expect((await revalueItem(b, { db, source: new SampleSource() })).ok).toBe(false);
    expect(db.select().from(items).where(eq(items.id, b)).get()).toEqual(before);
  });
});

describe("photos of a deleted item", () => {
  it("stay through the photo cleanup and when the last sibling goes, and restore brings everything back", async () => {
    const { scanId, a, b } = await multiScan();
    const aFiles = filesOf(eq(images.itemId, a));
    const sourceFiles = filesOf(eq(images.role, "source"));
    const history = db.select().from(valuations).where(eq(valuations.itemId, a)).all();
    expect(aFiles.length).toBeGreaterThan(0);
    expect(history.length).toBeGreaterThan(0);

    expect(softDeleteItems([a], db)).toBe(1);
    // As if every file were days old: only rows protect them.
    await removeOrphanPhotos(db, uploadsDir(), new Date(Date.now() + 3 * DAY));
    for (const f of [...aFiles, ...sourceFiles]) expect(await exists(f)).toBe(true);

    // The other card from the same photo is deleted for good: the scan photo stays for a.
    softDeleteItems([b], db);
    expect(await purgeItems([b], db)).toBe(1);
    expect(db.select().from(scans).where(eq(scans.id, scanId)).get()).toBeDefined();
    for (const f of [...aFiles, ...sourceFiles]) expect(await exists(f)).toBe(true);

    expect(restoreItems([a], db)).toBe(1);
    expect(listItems(all, db).rows.map((r) => r.id)).toEqual([a]);
    expect(filesOf(eq(images.itemId, a))).toEqual(aFiles);
    expect(db.select().from(valuations).where(eq(valuations.itemId, a)).all()).toEqual(history);
    expect(getScanView(scanId, db)!.items.map((i) => i.id)).toEqual([a]);
  });

  it("merging duplicates still removes the extra row at once (not to the bin)", async () => {
    const { a, b } = await multiScan(false);
    db.update(items).set({ status: "confirmed" }).run();
    expect(mergeInto(b, a, db).ok).toBe(true);
    expect(db.select().from(items).where(eq(items.id, b)).get()).toBeUndefined();
    expect(db.select().from(items).where(eq(items.id, a)).get()!.quantity).toBe(2);
  });
});

describe("restore", () => {
  it("only brings back items in the bin, and survives a removed location", () => {
    const loc = db.insert(locations).values({ name: "Box 1" }).returning({ id: locations.id }).get().id;
    const live = insert({ title: "Live" });
    const gone = insert({ title: "Gone", locationId: loc });
    softDeleteItems([gone], db);
    db.delete(locations).where(eq(locations.id, loc)).run();
    expect(restoreItems([live, gone, gone, 999, -1], db)).toBe(1);
    expect(db.select().from(items).where(eq(items.id, gone)).get()).toMatchObject({ deletedAt: null, locationId: null });
    expect(restoreItems([gone], db)).toBe(0);
    expect(restoreItems([], db)).toBe(0);
  });

  it("sets updated_at to now so bulk undo sees the item as edited since", () => {
    const id = insert({});
    softDeleteItems([id], db, new Date("2026-11-01T00:00:00Z"));
    const at = new Date("2026-11-05T00:00:00Z");
    expect(restoreItems([id], db, at)).toBe(1);
    expect(db.select().from(items).where(eq(items.id, id)).get()?.updatedAt).toEqual(at);
  });

  it("keeps the first time an item was deleted", () => {
    const id = insert({});
    const first = new Date("2026-11-01T00:00:00Z");
    softDeleteItems([id], db, first);
    expect(softDeleteItems([id], db, new Date("2026-11-10T00:00:00Z"))).toBe(0);
    expect(db.select().from(items).where(eq(items.id, id)).get()!.deletedAt).toEqual(first);
  });
});

describe("purge after 30 days", () => {
  it("removes nothing at day 29 and the rows and files at day 31", async () => {
    const { scanId, a, b } = await multiScan(false);
    const kept = insert({ title: "Live" });
    const at = new Date();
    softDeleteItems([a, b], db, at);
    const files = [...filesOf(eq(images.scanId, scanId))];
    expect(files.length).toBeGreaterThan(0);

    expect(await purgeExpired(db, new Date(at.getTime() + 29 * DAY))).toBe(0);
    expect(db.select().from(items).all()).toHaveLength(3);
    for (const f of files) expect(await exists(f)).toBe(true);

    expect(await purgeExpired(db, new Date(at.getTime() + 31 * DAY))).toBe(2);
    expect(db.select({ id: items.id }).from(items).all()).toEqual([{ id: kept }]);
    expect(db.select().from(images).all()).toEqual([]);
    expect(db.select().from(valuations).all()).toEqual([]);
    expect(db.select().from(scans).all()).toEqual([]);
    for (const f of files) expect(await exists(f)).toBe(false);
  });

  it("purgeItems never touches a live item", async () => {
    const id = insert({});
    expect(await purgeItems([id], db)).toBe(0);
    expect(db.select().from(items).all()).toHaveLength(1);
  });

  it("counts days left", () => {
    const at = new Date("2026-11-01T00:00:00Z");
    expect(daysLeft(at, at)).toBe(BIN_DAYS);
    expect(daysLeft(at, new Date(at.getTime() + 29.5 * DAY))).toBe(1);
    expect(daysLeft(at, new Date(at.getTime() + 40 * DAY))).toBe(0);
  });

  it("the daily job runs at most once a day", async () => {
    resetBinPurge();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crd-bin-"));
    const marker = path.join(dir, ".bin-purge");
    const id = insert({});
    const now = new Date();
    softDeleteItems([id], db, new Date(now.getTime() - 31 * DAY));
    expect(await maybePurgeBin({ db, now, marker })).toBe(1);
    expect(maybePurgeBin({ db, now: new Date(now.getTime() + DAY / 2), marker })).toBeNull();
    resetBinPurge();
    // After a restart the marker file stops an early second run.
    expect(await maybePurgeBin({ db, now: new Date(now.getTime() + DAY / 2), marker })).toBe(0);
    resetBinPurge();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("the daily job also drops old bulk undo rows, and the automatic purge scrubs undo text", async () => {
    resetBinPurge();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crd-bin-"));
    const marker = path.join(dir, ".bin-purge");
    const now = new Date();
    const id = insert({ player: "Secret" });
    const old = applyBulk({ ids: [id] }, { type: "status", status: "confirmed" }, db, new Date(now.getTime() - 40 * DAY));
    expect("opId" in old).toBe(true);
    // A pruned row needs no new bulk edit; the purge below also scrubs this one.
    const other = insert({ player: "Secret2" });
    applyBulk({ ids: [other] }, { type: "status", status: "confirmed" }, db, new Date(now.getTime() - DAY));
    softDeleteItems([other], db, new Date(now.getTime() - 31 * DAY));
    expect(await maybePurgeBin({ db, now, marker })).toBe(1);
    expect(db.select().from(bulkOps).all()).toEqual([]);
    resetBinPurge();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a failed purge is logged with its kind and does not write the marker, so the next visit tries again", async () => {
    resetBinPurge();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crd-bin-"));
    const marker = path.join(dir, ".bin-purge");
    const id = insert({});
    const now = new Date();
    softDeleteItems([id], db, new Date(now.getTime() - 31 * DAY));
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const spy = vi.spyOn(db, "select").mockImplementation(() => { throw new TypeError("boom with private words"); });
    expect(await maybePurgeBin({ db, now, marker })).toBe(0);
    spy.mockRestore();
    setLogSink();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "bin_purge_failed", level: "error", error: "TypeError" });
    expect(lines[0]).not.toContain("private words");
    expect(await exists(marker)).toBe(false);
    // Next visit (new process): the marker is missing, so it purges and then writes it.
    resetBinPurge();
    expect(await maybePurgeBin({ db, now, marker })).toBe(1);
    expect(Number(await fs.readFile(marker, "utf8"))).toBe(now.getTime());
    resetBinPurge();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("says plain words when no days are left", () => {
    expect(timeLeftText(0)).toBe("It will be removed for good soon.");
    expect(timeLeftText(1)).toBe("It is removed for good in 1 day.");
    expect(timeLeftText(12)).toBe("It is removed for good in 12 days.");
  });
});

describe("scan activity and the bin", () => {
  it("a one-card scan whose card is deleted says it is in the bin, with no photo, and comes back on restore", async () => {
    const one = db.insert(scans).values({ mode: "single", status: "done", itemCount: 1 }).returning({ id: scans.id }).get().id;
    const two = db.insert(scans).values({ mode: "multi", status: "done", itemCount: 2 }).returning({ id: scans.id }).get().id;
    const a = insert({ scanId: one });
    const b = insert({ scanId: two });
    insert({ scanId: two });
    for (const s of [one, two]) {
      db.insert(images).values({ scanId: s, role: "front", file: `f${s}.jpg`, thumbFile: `t${s}.jpg`, width: 1, height: 1, bytes: 1 }).run();
    }
    softDeleteItems([a, b], db);
    const list = recentScans(50, db);
    const v1 = list.find((s) => s.id === one)!;
    expect([v1.items.length, v1.inBin]).toEqual([0, 1]);
    const v2 = list.find((s) => s.id === two)!;
    expect([v2.items.length, v2.inBin]).toEqual([1, 1]);
    expect(getScanView(one, db)!.inBin).toBe(1);
    const thumbs = scanPhotoThumbs([one, two], db);
    expect(thumbs.has(one)).toBe(false);
    expect(thumbs.get(two)).toBe(`t${two}.jpg`);
    restoreItems([a], db);
    expect(scanPhotoThumbs([one], db).get(one)).toBe(`t${one}.jpg`);
    expect(getScanView(one, db)!.inBin).toBe(0);
  });
});

describe("purging a big bin", () => {
  it("removes more than 500 items, in batches", async () => {
    const db2 = createDb(":memory:");
    const n = 1203;
    db2.insert(items).values(Array.from({ length: n }, (_, i) => ({ kind: "card" as const, title: `T${i}`, deletedAt: new Date() }))).run();
    const all = db2.select({ id: items.id }).from(items).all().map((r) => r.id);
    const txs = vi.spyOn(db2, "transaction");
    expect(await purgeItems(all, db2)).toBe(n);
    expect(txs).toHaveBeenCalledTimes(3);
    expect(db2.select({ id: items.id }).from(items).all()).toHaveLength(0);
  });
});
