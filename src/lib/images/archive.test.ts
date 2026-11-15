import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, scans, type ImageRow } from "@/db/schema";
import { recognizedItemSchema, RecognitionError, type RecognitionRequest, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { createScan } from "@/lib/scans/create";
import { processScan, retryScan } from "@/lib/scans/process";
import { deleteFailedScans } from "@/lib/items/remove";
import {
  ARCHIVE_PER_MINUTE,
  convertPhoto,
  convertScanPhotos,
  FAILED_KEEP_MS,
  formatBytes,
  photosToConvert,
  resetPhotoArchiver,
  startPhotoArchiver,
  storageSummary,
} from "./archive";
import { removeOrphanPhotos } from "./cleanup";
import { uploadsDir } from "./store";

const DAY = 24 * 60 * 60 * 1000;
const up = (f: string) => path.join(uploadsDir(), f);
const wk = (f: string) => path.join(uploadsDir(), "work", f);
const has = (p: string) => fs.existsSync(p);

async function photo(color = "#336699", width = 1500, height = 2100): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

function fake(result: RecognizedItemInput[] | Error, seen?: RecognitionRequest[]): Recognizer {
  return {
    name: "fake-model",
    async recognize(req) {
      seen?.push(req);
      if (result instanceof Error) throw result;
      return result.map((r) => recognizedItemSchema.parse(r));
    },
  };
}
const card: RecognizedItemInput = { kind: "card", confidence: 0.9, player: "Ken Griffey Jr.", year: 1989 };

const rows = (db: Db) => db.select().from(images).all();

/** Checks a converted photo: AVIF on disk at the right size, no working copy, and its old files gone. */
async function expectArchived(row: ImageRow, edge: number, exact = true) {
  expect(row.workFile).toBeNull();
  expect(row.file.endsWith(".avif") && row.thumbFile.endsWith("_t.avif")).toBe(true);
  const meta = await sharp(up(row.file)).metadata();
  expect([meta.format, meta.compression]).toEqual(["heif", "av1"]);
  if (exact) expect(Math.max(meta.width!, meta.height!)).toBe(edge);
  else expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(edge);
  expect([row.width, row.height]).toEqual([meta.width, meta.height]);
  expect(row.bytes).toBe(fs.statSync(up(row.file)).size);
  expect(row.thumbBytes).toBe(fs.statSync(up(row.thumbFile)).size);
  const id = row.file.replace(".avif", "");
  expect(has(wk(`${id}.jpg`))).toBe(false);
  expect(has(up(`${id}.jpg`)) || has(up(`${id}_t.jpg`))).toBe(false);
}

/** A photo as stored before AVIF: a 2000 px JPEG and a 400 px JPEG small picture. */
async function legacyPhoto(db: Db, values: Partial<typeof images.$inferInsert> = {}): Promise<ImageRow> {
  const id = randomUUID();
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const main = await sharp(await photo("#884422", 1430, 2000)).jpeg({ quality: 85 }).toBuffer();
  fs.writeFileSync(up(`${id}.jpg`), main);
  fs.writeFileSync(up(`${id}_t.jpg`), await sharp(main).resize(400).jpeg().toBuffer());
  return db.insert(images).values({ role: "front", file: `${id}.jpg`, thumbFile: `${id}_t.jpg`, width: 1430, height: 2000, bytes: main.length, ...values }).returning().get();
}

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  resetPhotoArchiver();
});

describe("after a scan", () => {
  it("reads the working copy, then converts a single card's photos and removes the working copies", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }, { role: "back", data: await photo("#993333") }] }, db);
    const before = rows(db);
    expect(before.every((r) => r.workFile && has(wk(r.workFile)))).toBe(true);
    // Not touched while the scan waits in line.
    expect(photosToConvert(db, new Date(), 10)).toHaveLength(0);

    const seen: RecognitionRequest[] = [];
    await processScan(scanId, { db, recognizer: fake([card], seen) });
    // Recognition got the full quality working copies, byte for byte.
    expect(seen[0].photos.map((p, i) => p.data.equals(fs.readFileSync(wk(before[i].workFile!))))).toEqual([true, true]);
    expect(seen[0].photos.map((p) => [p.width, p.height])).toEqual([[1429, 2000], [1429, 2000]]);

    expect(await convertScanPhotos(scanId, db)).toBe(2);
    const after = rows(db);
    for (const r of after) await expectArchived(r, 1200);
    // Same names: links shown during the scan keep working.
    expect(after.map((r) => r.file)).toEqual(before.map((r) => r.file));
    expect(after.every((r) => r.itemId === db.select().from(items).get()!.id)).toBe(true);
  });

  it("cuts cards out of the working copy of a multi-card photo, then archives the photo at 1600 px and crops at 1200 px", async () => {
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo("#336699", 3000, 2000) }] }, db);
    await processScan(scanId, {
      db,
      recognizer: fake([{ ...card, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.8 } }, { ...card, player: "Bo Jackson", box: { x: 0.55, y: 0.05, w: 0.4, h: 0.8 } }]),
    });
    const crops = db.select().from(images).where(eq(images.role, "crop")).all();
    expect(crops).toHaveLength(2);
    expect(crops.every((c) => c.workFile && has(wk(c.workFile)))).toBe(true);

    // The background converter does it once no scan is being read.
    let busy = true;
    const waits: number[] = [];
    const run = startPhotoArchiver({ db, busy: () => busy, sleep: async (ms) => { waits.push(ms); busy = false; } });
    expect(await run).toBe(3);
    expect(waits).toHaveLength(1);
    const source = db.select().from(images).where(eq(images.role, "source")).get()!;
    await expectArchived(source, 1600);
    for (const c of db.select().from(images).where(eq(images.role, "crop")).all()) await expectArchived(c, 1200, false);
    expect(fs.readdirSync(path.join(uploadsDir(), "work")).filter((f) => crops.some((c) => c.workFile === f))).toEqual([]);
  });
});

describe("failed scans", () => {
  it("keep their working copy for a retry, which still works, and are converted after 7 days", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const t0 = new Date();
    await processScan(scanId, { db, recognizer: fake(new RecognitionError("Busy.")), now: () => t0 });
    const [row] = rows(db);
    expect(row.workFile).not.toBeNull();
    expect(await startPhotoArchiver({ db })).toBe(0);
    expect(photosToConvert(db, new Date(t0.getTime() + FAILED_KEEP_MS - 1000), 10)).toHaveLength(0);
    expect(has(wk(row.workFile!))).toBe(true);

    // Retry within the 7 days reads the same working copy.
    expect(retryScan(scanId, db)).toEqual({ ok: true });
    const seen: RecognitionRequest[] = [];
    await processScan(scanId, { db, recognizer: fake([card], seen) });
    expect(seen[0].photos[0].data.equals(fs.readFileSync(wk(row.workFile!)))).toBe(true);
    expect(db.select().from(scans).get()!.status).toBe("done");
  });

  it("can still be retried after their photos were converted", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const t0 = new Date();
    await processScan(scanId, { db, recognizer: fake(new RecognitionError("Busy.")), now: () => t0 });
    const later = new Date(t0.getTime() + FAILED_KEEP_MS + 1000);
    expect(await startPhotoArchiver({ db, now: () => later })).toBe(1);
    await expectArchived(rows(db)[0], 1200);

    expect(retryScan(scanId, db)).toEqual({ ok: true });
    const seen: RecognitionRequest[] = [];
    await processScan(scanId, { db, recognizer: fake([card], seen) });
    expect((await sharp(seen[0].photos[0].data).metadata()).format).toBe("jpeg");
    expect(db.select().from(scans).get()!.status).toBe("done");
  });

  it("are not touched while a retry is queued or running, even when old", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const old = new Date(Date.now() - 30 * DAY);
    await processScan(scanId, { db, recognizer: fake(new RecognitionError("Busy.")), now: () => old });
    const [row] = rows(db);
    // The owner presses retry while the converter is already writing the archive.
    const converting = convertPhoto(db, row, new Date(), { afterWrite: () => { retryScan(scanId, db); } });
    expect(await converting).toBe(false);
    expect(rows(db)[0]).toEqual(row);
    expect(has(wk(row.workFile!))).toBe(true);
    expect(has(up(row.file))).toBe(false);
    for (const status of ["queued", "processing"] as const) {
      db.update(scans).set({ status }).where(eq(scans.id, scanId)).run();
      expect(photosToConvert(db, new Date(), 10)).toHaveLength(0);
    }
  });

  it("lose every form of their photos when deleted", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake(new RecognitionError("Busy.")) });
    const [row] = rows(db);
    expect(await deleteFailedScans(db)).toBe(1);
    expect([has(wk(row.workFile!)), has(up(row.thumbFile)), has(up(row.file))]).toEqual([false, false, false]);
  });
});

describe("older JPEG photos", () => {
  it("are converted in the background, at most the set number per minute", async () => {
    const scan = db.insert(scans).values({ mode: "single", status: "done" }).returning().get();
    const legacy = [];
    for (let i = 0; i < 5; i++) legacy.push(await legacyPhoto(db, { scanId: scan.id }));
    const sealed = await legacyPhoto(db, { role: "source" });
    const waits: number[] = [];
    const total = await startPhotoArchiver({ db, perMinute: 2, sleep: async (ms) => { waits.push(ms); } });
    expect(total).toBe(6);
    // 6 photos at 2 a minute: waits after the 2nd and 4th.
    expect(waits).toHaveLength(2);
    expect(waits.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
    const after = rows(db);
    for (const r of after.filter((r) => r.id !== sealed.id)) await expectArchived(r, 1200);
    await expectArchived(after.find((r) => r.id === sealed.id)!, 1600);
    for (const r of legacy) expect([has(up(r.file)), has(up(r.thumbFile))]).toEqual([false, false]);
    expect(ARCHIVE_PER_MINUTE).toBe(10);
  });

  it("never touch photos of a scan that is queued or being read", async () => {
    for (const status of ["queued", "processing"] as const) {
      const scan = db.insert(scans).values({ mode: "single", status }).returning().get();
      await legacyPhoto(db, { scanId: scan.id });
    }
    expect(await startPhotoArchiver({ db })).toBe(0);
    expect(rows(db).every((r) => r.file.endsWith(".jpg"))).toBe(true);
  });

  it("survive a stop after the new file is written: the row is unchanged and the next run finishes", async () => {
    const row = await legacyPhoto(db);
    await expect(convertPhoto(db, row, new Date(), { afterWrite: () => { throw new Error("power cut"); } })).rejects.toThrow();
    expect(rows(db)[0]).toEqual(row);
    expect(has(up(row.file)) && has(up(row.thumbFile))).toBe(true);
    // The photo still shows from the old JPEG, and the next run converts it.
    expect(await startPhotoArchiver({ db })).toBe(1);
    await expectArchived(rows(db)[0], 1200);
  });

  it("survive a stop after the row is switched: only unused old files are left, and the cleanup removes them", async () => {
    const row = await legacyPhoto(db);
    await expect(convertPhoto(db, row, new Date(), { afterCommit: () => { throw new Error("power cut"); } })).rejects.toThrow();
    const after = rows(db)[0];
    expect(after.file).toBe(row.file.replace(".jpg", ".avif"));
    expect(has(up(after.file)) && has(up(after.thumbFile))).toBe(true);
    expect(has(up(row.file)) && has(up(row.thumbFile))).toBe(true);
    expect(photosToConvert(db, new Date(), 10)).toHaveLength(0);
    // A day later the leftovers count as orphans.
    const later = new Date(Date.now() + 2 * DAY);
    await removeOrphanPhotos(db, uploadsDir(), later);
    expect([has(up(row.file)), has(up(row.thumbFile))]).toEqual([false, false]);
    await expectArchived(after, 1200);
  });

  it("are left alone when the photo is deleted while converting", async () => {
    const row = await legacyPhoto(db);
    const ok = await convertPhoto(db, row, new Date(), { afterWrite: () => { db.delete(images).run(); } });
    expect(ok).toBe(false);
    const id = row.file.replace(".jpg", "");
    expect([has(up(`${id}.avif`)), has(up(`${id}_t.avif`))]).toEqual([false, false]);
  });
});

describe("storageSummary", () => {
  it("counts photos, space, average per card and photos waiting", async () => {
    expect(storageSummary(db)).toEqual({ photos: 0, totalBytes: 0, items: 0, perItemBytes: null, waiting: 0 });
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }, { role: "back", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake([card]) });
    await legacyPhoto(db);
    const waiting = storageSummary(db);
    expect(waiting).toMatchObject({ photos: 3, items: 1, waiting: 3 });

    await startPhotoArchiver({ db });
    const s = storageSummary(db);
    const onDisk = rows(db).reduce((n, r) => n + fs.statSync(up(r.file)).size + fs.statSync(up(r.thumbFile)).size, 0);
    expect(s).toEqual({ photos: 3, totalBytes: onDisk, items: 1, perItemBytes: onDisk, waiting: 0 });
    expect(s.totalBytes).toBeLessThan(waiting.totalBytes);
  });

  it("prints sizes in plain words", () => {
    expect([formatBytes(0), formatBytes(999), formatBytes(48_200), formatBytes(1_250_000), formatBytes(345_000_000), formatBytes(2_100_000_000)])
      .toEqual(["0 bytes", "999 bytes", "48.2 KB", "1.3 MB", "345 MB", "2.1 GB"]);
  });
});
