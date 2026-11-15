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
import { deleteFailedScans } from "./remove";
import { deleteItem } from "./update";

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

describe("deleteItem", () => {
  it("keeps the scan's photo until its last card is deleted, then removes the photo and the scan", async () => {
    const { scanId, itemIds, files } = await multiScan();
    const source = db.select().from(images).where(eq(images.role, "source")).get()!;
    expect(await deleteItem(itemIds[0]!, db)).toEqual({ ok: true });
    expect(await exists(source.file)).toBe(true);
    expect(db.select().from(scans).where(eq(scans.id, scanId)).get()).toBeDefined();

    expect(await deleteItem(itemIds[1]!, db)).toEqual({ ok: true });
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
    await deleteItem(id, db);
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
    await expect(deleteItem(itemIds[0]!, broken)).rejects.toThrow();
    expect(db.select().from(items).all()).toHaveLength(2);
    for (const f of files) expect(await exists(f)).toBe(true);
  });
});

describe("merge of the last card of a scan", () => {
  it("also removes the scan's source photo", async () => {
    const { itemIds } = await multiScan();
    db.update(items).set({ status: "needs_review" }).where(eq(items.id, itemIds[1]!)).run();
    // Make the second card a duplicate of an older confirmed one from somewhere else.
    const target = db.insert(items).values({ kind: "card", title: "T", status: "confirmed", year: 1989, brand: "Upper Deck", cardNumber: "2", player: "Ken Griffey Jr." }).returning().get();
    await deleteItem(itemIds[0]!, db);
    const r = mergeInto(itemIds[1]!, target.id, db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files.length).toBeGreaterThanOrEqual(2);
    expect(db.select().from(scans).all()).toHaveLength(0);
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
