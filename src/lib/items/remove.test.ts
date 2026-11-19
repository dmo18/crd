import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, scans, valuations } from "@/db/schema";
import { convertScanPhotos } from "@/lib/images/archive";
import { uploadsDir } from "@/lib/images/store";
import { recognizedItemSchema, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { createScan } from "@/lib/scans/create";
import { processScan } from "@/lib/scans/process";
import { mergeInto } from "./duplicates";
import { purgeItems, softDeleteItems } from "./bin";
import { deleteFailedScans } from "./remove";

const photo = () => sharp({ create: { width: 900, height: 1200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
const exists = (f: string) => fs.access(path.join(uploadsDir(), f)).then(() => true, () => false);
const fake = (result: RecognizedItemInput[]): Recognizer => ({
  name: "fake", async recognize() { return result.map((r) => recognizedItemSchema.parse(r)); },
});
const card: RecognizedItemInput = {
  kind: "card", confidence: 0.95, sport: "baseball", year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.",
  estimate: { lowCents: 100, highCents: 300, basis: "x" },
};

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

/** Delete forever: to the bin, then purged, as the bin screen and the daily job do. */
async function forever(id: number, on: Db = db): Promise<number> {
  softDeleteItems([id], db);
  return purgeItems([id], on);
}

async function multiScan() {
  const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
  await processScan(scanId, {
    db,
    recognizer: fake([
      { ...card, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
      { ...card, cardNumber: "2", box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } },
    ]),
  });
  // The photos in their archive form, as after the background converter.
  expect(await convertScanPhotos(scanId, db)).toBe(3);
  const rows = db.select().from(images).all();
  return { scanId, itemIds: db.select({ id: items.id }).from(items).all().map((r) => r.id), files: rows.flatMap((r) => [r.file, r.thumbFile]) };
}

describe("deleting an item forever (purge)", () => {
  it("keeps the scan's photo until its last card is deleted, then removes the photo and the scan", async () => {
    const { scanId, itemIds, files } = await multiScan();
    const source = db.select().from(images).where(eq(images.role, "source")).get()!;
    expect(await forever(itemIds[0]!)).toBe(1);
    expect(await exists(source.file)).toBe(true);
    expect(db.select().from(scans).where(eq(scans.id, scanId)).get()).toBeDefined();

    expect(await forever(itemIds[1]!)).toBe(1);
    expect(db.select().from(scans).all()).toHaveLength(0);
    expect(db.select().from(images).all()).toHaveLength(0);
    expect(db.select().from(valuations).all()).toHaveLength(0);
    for (const f of files) expect(await exists(f)).toBe(false);
  });

  it("removes a single card's front and back photos with their small versions and working copies", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }, { role: "back", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake([card]) });
    // Not converted yet: the working copies must go too.
    const rows = db.select().from(images).all();
    const files = rows.flatMap((r) => [r.thumbFile, `work/${r.workFile}`]);
    expect(files).toHaveLength(4);
    for (const f of files) expect(await exists(f)).toBe(true);
    const id = db.select().from(items).get()!.id;
    expect(await forever(id)).toBe(1);
    for (const f of files) expect(await exists(f)).toBe(false);
    expect(db.select().from(scans).all()).toHaveLength(0);
  });

  it("changes nothing when the database step fails", async () => {
    const { itemIds, files } = await multiScan();
    const broken = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "transaction") return () => { throw new Error("disk full"); };
        return Reflect.get(target, prop, recv);
      },
    });
    await expect(forever(itemIds[0]!, broken)).rejects.toThrow();
    expect(db.select().from(items).all()).toHaveLength(2);
    for (const f of files) expect(await exists(f)).toBe(true);
  });
});

describe("merge of the last card of a scan", () => {
  it("moves the card's own photo and keeps the scan with its whole-sheet photo", async () => {
    const { scanId, itemIds, files } = await multiScan();
    db.update(items).set({ status: "needs_review" }).where(eq(items.id, itemIds[1]!)).run();
    // Make the second card a duplicate of an older confirmed one from somewhere else.
    const target = db.insert(items).values({ kind: "card", title: "T", status: "confirmed", year: 1989, brand: "Upper Deck", cardNumber: "2", player: "Ken Griffey Jr." }).returning().get();
    await forever(itemIds[0]!);
    // The kept record must be the older one (lower id): take the id the removed first card had.
    db.update(items).set({ id: itemIds[0]! }).where(eq(items.id, target.id)).run();
    target.id = itemIds[0]!;
    const crop = db.select().from(images).where(eq(images.itemId, itemIds[1]!)).get()!;
    const left = db.select().from(images).all();
    const r = mergeInto(itemIds[1]!, target.id, db);
    expect(r).toEqual({ ok: true, targetId: target.id, movedPhotos: 1 });
    // No photo row and no file is gone: the crop is on the kept record, the sheet stays with its scan.
    expect(db.select().from(images).all()).toHaveLength(left.length);
    expect(db.select().from(images).where(eq(images.id, crop.id)).get()).toMatchObject({ itemId: target.id, scanId: null, file: crop.file });
    expect(db.select().from(images).where(eq(images.role, "source")).get()).toMatchObject({ scanId, itemId: null });
    expect(db.select().from(scans).all()).toHaveLength(1);
    for (const f of left.flatMap((x) => [x.file, x.thumbFile])) expect(await exists(f), f).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    // Deleting the kept record later takes its photos, but not the scan's sheet.
    await forever(target.id);
    expect(await exists(crop.file)).toBe(false);
    expect(db.select().from(images).where(eq(images.role, "source")).all()).toHaveLength(1);
  });
});

describe("deleteFailedScans", () => {
  it("removes failed scans and their photos and keeps the rest", async () => {
    const bad = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    db.update(scans).set({ status: "failed", error: "Bad" }).where(eq(scans.id, bad.scanId)).run();
    const badFiles = db.select().from(images).where(eq(images.scanId, bad.scanId)).all().flatMap((r) => [r.file, r.thumbFile]);
    const good = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    expect(await deleteFailedScans(db)).toBe(1);
    expect(db.select({ id: scans.id }).from(scans).all()).toEqual([{ id: good.scanId }]);
    for (const f of badFiles) expect(await exists(f)).toBe(false);
    expect(db.select().from(images).where(eq(images.scanId, good.scanId)).all()).toHaveLength(1);
    expect(await deleteFailedScans(db)).toBe(0);
  });
});
