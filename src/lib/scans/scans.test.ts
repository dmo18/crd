import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, locations, scans, valuations } from "@/db/schema";
import { readStored } from "@/lib/images/store";
import { RecognitionError, recognizedItemSchema, type RecognitionRequest, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { createScan, ScanInputError } from "./create";
import { enqueueScan, processScan, queueIdle, queueOrder, RECOGNITION_DEADLINE_MS, recoverScans, retryScan, TOO_SLOW } from "./process";
import { getScanView } from "./view";

async function photo(color = "#336699"): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: color } }).jpeg().toBuffer();
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

const griffey: RecognizedItemInput = {
  kind: "card", confidence: 0.93, sport: "baseball", year: 1989, brand: "Upper Deck", setName: "Upper Deck",
  cardNumber: "1", player: "Ken Griffey Jr.", isRookie: true, rarityTier: "key",
  estimate: { lowCents: 4000, highCents: 8000, basis: "AI estimate." },
};

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

describe("createScan", () => {
  it("stores photos and queues a scan", async () => {
    const { scanId } = await createScan({ mode: "single", hint: "  1989  ", photos: [{ role: "front", data: await photo() }, { role: "back", data: await photo("#993333") }] }, db);
    const scan = db.select().from(scans).where(eq(scans.id, scanId)).get()!;
    expect(scan.status).toBe("queued");
    expect(scan.hint).toBe("1989");
    expect(db.select().from(images).all().map((i) => i.role)).toEqual(["front", "back"]);
  });

  it("rejects wrong photo sets and bad files", async () => {
    const p = await photo();
    await expect(createScan({ mode: "single", photos: [] }, db)).rejects.toBeInstanceOf(ScanInputError);
    await expect(createScan({ mode: "single", photos: [{ role: "back", data: p }] }, db)).rejects.toBeInstanceOf(ScanInputError);
    await expect(createScan({ mode: "multi", photos: [{ role: "front", data: p }] }, db)).rejects.toBeInstanceOf(ScanInputError);
    await expect(createScan({ mode: "sealed", photos: Array(5).fill({ role: "source", data: p }) }, db)).rejects.toBeInstanceOf(ScanInputError);
    await expect(createScan({ mode: "single", photos: [{ role: "front", data: Buffer.from("not a photo") }] }, db)).rejects.toBeInstanceOf(ScanInputError);
    await expect(createScan({ mode: "single", locationId: 999, photos: [{ role: "front", data: p }] }, db)).rejects.toBeInstanceOf(ScanInputError);
    expect(db.select().from(scans).all()).toHaveLength(0);
    expect(db.select().from(images).all()).toHaveLength(0);
  });
});

describe("processScan", () => {
  it("files a confident single card as confirmed with its photos and value", async () => {
    const loc = db.insert(locations).values({ name: "Box 1" }).returning().get();
    const { scanId } = await createScan({ mode: "single", locationId: loc.id, hint: "rookie", photos: [{ role: "front", data: await photo() }, { role: "back", data: await photo() }] }, db);
    const seen: RecognitionRequest[] = [];
    await processScan(scanId, { db, recognizer: fake([griffey], seen) });

    expect(seen[0].mode).toBe("single");
    expect(seen[0].hint).toBe("rookie");
    expect(seen[0].photos.map((p) => p.role)).toEqual(["front", "back"]);
    const scan = db.select().from(scans).get()!;
    expect(scan).toMatchObject({ status: "done", itemCount: 1, recognizer: "fake-model", error: null });
    const item = db.select().from(items).get()!;
    expect(item).toMatchObject({
      kind: "card", status: "confirmed", title: "1989 Upper Deck #1 Ken Griffey Jr.", isRookie: true, locationId: loc.id,
      estLowCents: 4000, estHighCents: 8000, estValueCents: 6000, valueSource: "ai_estimate",
    });
    expect(db.select().from(images).all().every((i) => i.itemId === item.id)).toBe(true);
    expect(db.select().from(valuations).get()).toMatchObject({ itemId: item.id, valueCents: 6000 });
  });

  it("sends unsure results to review", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake([{ ...griffey, confidence: 0.5 }]) });
    expect(db.select().from(items).get()!.status).toBe("needs_review");
  });

  it("cuts each card out of a multi-card photo", async () => {
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
    await processScan(scanId, {
      db,
      recognizer: fake([
        { ...griffey, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
        { ...griffey, player: "Bo Jackson", cardNumber: "8", box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } },
        { ...griffey, player: "No Box", box: null },
      ]),
    });
    expect(db.select().from(items).all()).toHaveLength(3);
    const crops = db.select().from(images).where(eq(images.role, "crop")).all();
    expect(crops).toHaveLength(2);
    expect(new Set(crops.map((c) => c.itemId)).size).toBe(2);
    expect((await readStored(crops[0].file)).length).toBeGreaterThan(0);
    // The original photo stays with the scan, not with any one card.
    expect(db.select().from(images).where(eq(images.role, "source")).get()!.itemId).toBeNull();
  });

  it("files sealed product and bulk lots with the right fields only", async () => {
    const a = await createScan({ mode: "sealed", photos: [{ role: "source", data: await photo() }] }, db);
    await processScan(a.scanId, { db, recognizer: fake([{ kind: "sealed", confidence: 0.9, year: 1990, brand: "Topps", sport: "baseball", productType: "box", packCount: 36, sealState: "factory_sealed", player: "ignored", pullList: ["Frank Thomas #414"] }]) });
    const b = await createScan({ mode: "bulk", photos: [{ role: "source", data: await photo() }] }, db);
    await processScan(b.scanId, { db, recognizer: fake([{ kind: "bulk", confidence: 0.8, year: 1987, yearEnd: 1991, estCount: 800, containerType: "800 count box" }]) });
    const [sealed, bulk] = db.select().from(items).all();
    expect(sealed).toMatchObject({ kind: "sealed", productType: "box", packCount: 36, player: null, title: "1990 Topps baseball box" });
    expect(JSON.parse(sealed.pullList!)).toEqual(["Frank Thomas #414"]);
    expect(bulk).toMatchObject({ kind: "bulk", estCount: 800, yearEnd: 1991, productType: null });
    expect(db.select().from(images).where(eq(images.itemId, sealed.id)).all()).toHaveLength(1);
  });

  it("records a safe message on failure and hides internal errors", async () => {
    const a = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(a.scanId, { db, recognizer: fake(new RecognitionError("The AI service is busy. Try again in a minute.")) });
    const b = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(b.scanId, { db, recognizer: fake(new Error("secret internal detail /var/lib/x")) });
    const [first, second] = db.select().from(scans).all();
    expect(first).toMatchObject({ status: "failed", error: "The AI service is busy. Try again in a minute." });
    expect(second.status).toBe("failed");
    expect(second.error).not.toContain("secret");
    expect(db.select().from(items).all()).toHaveLength(0);
  });

  it("fails a scan that takes longer than the deadline", async () => {
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
    let started!: () => void;
    const called = new Promise<void>((r) => { started = r; });
    const never: Recognizer = { name: "stuck", recognize: () => { started(); return new Promise(() => undefined); } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = processScan(scanId, { db, recognizer: never });
      await called;
      await vi.advanceTimersByTimeAsync(RECOGNITION_DEADLINE_MS - 1000);
      expect(db.select().from(scans).get()?.status).toBe("processing");
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(db.select().from(scans).get()).toMatchObject({ status: "failed", error: TOO_SLOW });
    expect(db.select().from(items).all()).toHaveLength(0);
  });

  it("clears the deadline timer when recognition finishes in time", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    await processScan(scanId, { db, recognizer: fake([griffey]), deadlineMs: 60_000 });
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
    expect(db.select().from(scans).get()).toMatchObject({ status: "done", itemCount: 1 });
  });

  it("uses a short injected deadline", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const never: Recognizer = { name: "stuck", recognize: () => new Promise(() => undefined) };
    await processScan(scanId, { db, recognizer: never, deadlineMs: 20 });
    expect(db.select().from(scans).get()).toMatchObject({ status: "failed", error: TOO_SLOW });
  });

  it("handles a photo with nothing in it, and never processes a scan twice", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake([]) });
    expect(db.select().from(scans).get()).toMatchObject({ status: "done", itemCount: 0 });
    await processScan(scanId, { db, recognizer: fake([griffey]) });
    expect(db.select().from(items).all()).toHaveLength(0);
  });
});

describe("queue", () => {
  it("runs queued scans in order and recovers interrupted ones", async () => {
    const p = await photo();
    const a = await createScan({ mode: "single", photos: [{ role: "front", data: p }] }, db);
    const b = await createScan({ mode: "single", photos: [{ role: "front", data: p }] }, db);
    const c = await createScan({ mode: "single", photos: [{ role: "front", data: p }] }, db);
    // Pretend the server died while scan c was being processed ten minutes ago.
    db.update(scans).set({ status: "processing", createdAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(scans.id, c.scanId)).run();
    const deps = { db, recognizer: fake([griffey]) };
    enqueueScan(a.scanId, deps);
    enqueueScan(a.scanId, deps);
    recoverScans(deps);
    await queueIdle();
    expect(db.select().from(scans).all().map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(db.select().from(items).all()).toHaveLength(3);
    expect(b.scanId).toBeGreaterThan(a.scanId);
  });
});

describe("scan view timing and place in line", () => {
  it("records when processing started and shows the place in line while queued", async () => {
    const p = await photo();
    const a = await createScan({ mode: "single", photos: [{ role: "front", data: p }] }, db);
    const b = await createScan({ mode: "single", photos: [{ role: "front", data: p }] }, db);
    expect(getScanView(a.scanId, db)).toMatchObject({ status: "queued", startedAt: null, queuePosition: 1 });
    expect(getScanView(b.scanId, db)).toMatchObject({ queuePosition: 2 });

    const at = new Date("2026-03-01T10:00:00Z");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: Recognizer = { name: "slow", async recognize() { await gate; return [recognizedItemSchema.parse(griffey)]; } };
    const deps = { db, recognizer: slow, now: () => at };
    enqueueScan(a.scanId, deps);
    enqueueScan(b.scanId, deps);
    await vi.waitFor(() => expect(db.select().from(scans).where(eq(scans.id, a.scanId)).get()?.status).toBe("processing"));
    expect(queueOrder()).toEqual([a.scanId, b.scanId]);
    expect(getScanView(a.scanId, db, queueOrder())).toMatchObject({ status: "processing", startedAt: at.getTime(), queuePosition: null });
    // Scan b runs next, after the one being read now.
    expect(getScanView(b.scanId, db, queueOrder())).toMatchObject({ status: "queued", startedAt: null, queuePosition: 1 });
    release();
    await queueIdle();
    expect(getScanView(b.scanId, db)).toMatchObject({ status: "done", startedAt: at.getTime(), queuePosition: null });
  });

  it("recovers a scan only when it started long ago, not when it was merely created long ago", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    db.update(scans).set({ status: "processing", createdAt: longAgo, startedAt: new Date() }).where(eq(scans.id, scanId)).run();
    recoverScans({ db, recognizer: fake([griffey]) });
    await queueIdle();
    expect(db.select().from(scans).get()?.status).toBe("processing");
    db.update(scans).set({ startedAt: longAgo }).where(eq(scans.id, scanId)).run();
    recoverScans({ db, recognizer: fake([griffey]) });
    await queueIdle();
    expect(db.select().from(scans).get()?.status).toBe("done");
  });
});

describe("retryScan", () => {
  it("re-runs a failed scan with the photos it already has", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(scanId, { db, recognizer: fake(new RecognitionError("Busy.")) });
    expect(db.select().from(scans).get()).toMatchObject({ status: "failed", error: "Busy." });
    const photosBefore = db.select().from(images).all();

    expect(retryScan(scanId, db)).toEqual({ ok: true });
    expect(db.select().from(scans).get()).toMatchObject({ status: "queued", error: null, startedAt: null, finishedAt: null });
    await processScan(scanId, { db, recognizer: fake([griffey]) });
    expect(db.select().from(scans).all()).toHaveLength(1);
    expect(db.select().from(scans).get()).toMatchObject({ status: "done", itemCount: 1 });
    // The same photos, not a new upload.
    expect(db.select({ file: images.file }).from(images).all()).toEqual(photosBefore.map((p) => ({ file: p.file })));
  });

  it("refuses scans that did not fail, are missing, or lost their photos", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    expect(retryScan(scanId, db)).toMatchObject({ ok: false, status: 409 });
    expect(retryScan(9999, db)).toMatchObject({ ok: false, status: 404 });
    db.update(scans).set({ status: "failed" }).where(eq(scans.id, scanId)).run();
    db.delete(images).run();
    expect(retryScan(scanId, db)).toMatchObject({ ok: false, status: 410 });
    expect(db.select().from(scans).get()?.status).toBe("failed");
  });
});
