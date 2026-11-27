import fs from "node:fs";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, locations, scans, valuations } from "@/db/schema";
import { readPhoto, uploadsDir } from "@/lib/images/store";
import { RecognitionError, recognizedItemSchema, type RecognitionRequest, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { duplicateIds, findDuplicateMatches } from "@/lib/items/duplicates";
import { createScan, ScanInputError } from "./create";
import { enqueueScan, processScan, queueIdle, queueOrder, RECOGNITION_DEADLINE_MS, recoverScans, retryScan, TOO_SLOW } from "./process";
import { getScanView, recentScans, scanPhotoThumbs, scanStatusCounts, scanViews } from "./view";

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

  it("keeps a many-cards photo larger than a one card photo (each card's small print is read from it)", async () => {
    const big = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    await createScan({ mode: "multi", photos: [{ role: "source", data: big }] }, db);
    await createScan({ mode: "single", photos: [{ role: "front", data: big }] }, db);
    expect(db.select({ w: images.width, h: images.height, role: images.role }).from(images).all()).toEqual([
      { w: 3000, h: 4000, role: "source" },
      { w: 1500, h: 2000, role: "front" },
    ]);
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
      kind: "card", status: "confirmed", title: "1989 Upper Deck #1 Ken Griffey Jr.", isRookie: false, rookieState: null, rookieSource: "reading", locationId: loc.id,
      estLowCents: 4000, estHighCents: 8000, estValueCents: 6000, valueSource: "ai_estimate",
    });
    expect(db.select().from(images).all().every((i) => i.itemId === item.id)).toBe(true);
    expect(db.select().from(valuations).get()).toMatchObject({ itemId: item.id, valueCents: 6000 });
  });

  it("keeps what the reader first read and marks its fields as reading", async () => {
    const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    const at = new Date("2026-11-16T12:00:00Z");
    await processScan(scanId, { db, recognizer: fake([{ ...griffey, confidence: 0.5, team: null }]), now: () => at });
    const item = db.select().from(items).where(eq(items.scanId, scanId)).get()!;
    expect(JSON.parse(item.fieldSources!)).toEqual({
      sport: "reading", year: "reading", brand: "reading", setName: "reading", cardNumber: "reading", player: "reading",
    });
    expect(JSON.parse(item.firstSuggestion!)).toEqual({
      v: 1, confidence: 0.5, reader: "fake-model", at: at.getTime(),
      fields: { sport: "baseball", year: 1989, brand: "Upper Deck", setName: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr." },
      // The reader gave no fix for the photo, so it was not cut to the card: "Trim the photo" is offered for it.
      uncut: [{ id: db.select().from(images).where(eq(images.scanId, scanId)).get()!.id, w: 900, h: 1200 }],
    });
    expect(item.catalogCardId).toBeNull();
    expect(item.catalogCandidates).toBeNull();
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
    expect((await readPhoto(crops[0].file)).data.length).toBeGreaterThan(0);
    // The original photo stays with the scan, not with any one card.
    expect(db.select().from(images).where(eq(images.role, "source")).get()!.itemId).toBeNull();
  });

  it("a card from a many-cards scan meets the same duplicate check as one from a one card scan", async () => {
    const owned = db.insert(items).values({
      kind: "card", title: "1993 Fleer #65 Tim Hardaway", status: "confirmed", sport: "basketball", year: 1993, brand: "Fleer", cardNumber: "65", player: "Tim Hardaway",
    }).returning({ id: items.id }).get().id;
    const hardaway: RecognizedItemInput = { kind: "card", confidence: 0.65, sport: "basketball", year: 1993, brand: "Fleer", cardNumber: "65", player: "Tim Hardaway", estimate: null };
    const many = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
    await processScan(many.scanId, { db, recognizer: fake([{ ...hardaway, sourceIndex: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } }]) });
    const one = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(one.scanId, { db, recognizer: fake([hardaway]) });
    const fromMany = db.select().from(items).where(eq(items.scanId, many.scanId)).get()!;
    const fromOne = db.select().from(items).where(eq(items.scanId, one.scanId)).get()!;
    expect(fromMany.status).toBe("needs_review");
    for (const [scanned, twin] of [[fromMany, fromOne], [fromOne, fromMany]] as const) {
      // The other copy, also still in Review, is asked about too (only as a maybe).
      expect(findDuplicateMatches(scanned.id, db).map((m) => [m.item.id, m.kind])).toEqual([[owned, "same"], [twin.id, "maybe"]]);
      expect(duplicateIds(db)).toContain(scanned.id);
    }
  });

  describe("a card read again that may already be in the collection is never filed by itself (review 7, blocker)", () => {
    const hardaway: RecognizedItemInput = { kind: "card", confidence: 0.93, sport: "basketball", year: 1993, brand: "Fleer", cardNumber: "65", player: "Tim Hardaway", estimate: null };
    const milacki: RecognizedItemInput = { kind: "card", confidence: 0.93, sport: "baseball", year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki", estimate: null };
    const statusOf = (scanId: number) => db.select({ s: items.status, p: items.player }).from(items).where(eq(items.scanId, scanId)).all();
    async function oneCard(read: RecognizedItemInput, batchKey: string | null = null) {
      const { scanId } = await createScan({ mode: "single", batchKey, photos: [{ role: "front", data: await photo() }] }, db);
      await processScan(scanId, { db, recognizer: fake([read]) });
      return scanId;
    }

    it("one card scans: the first copy is filed, the second waits in Review as a possible duplicate", async () => {
      const first = await oneCard(hardaway);
      expect(statusOf(first)).toEqual([{ s: "confirmed", p: "Tim Hardaway" }]);
      const second = await oneCard(hardaway);
      expect(statusOf(second)).toEqual([{ s: "needs_review", p: "Tim Hardaway" }]);
      const again = db.select().from(items).where(eq(items.scanId, second)).get()!;
      // The choices of a same card: Count it with the old one is allowed.
      expect(findDuplicateMatches(again.id, db).map((m) => m.kind)).toEqual(["same"]);
    });

    it("many photos, one card each (a batch): both copies of an owned card wait; a new card is filed", async () => {
      await oneCard(hardaway);
      await oneCard(milacki);
      const a = await oneCard(hardaway, "b1");
      const b = await oneCard(milacki, "b1");
      const c = await oneCard({ ...milacki, player: "Cal Ripken, Jr.", cardNumber: "22" }, "b1");
      expect(statusOf(a)[0]!.s).toBe("needs_review");
      expect(statusOf(b)[0]!.s).toBe("needs_review");
      expect(statusOf(c)[0]!.s).toBe("confirmed");
    });

    it("a copy of one still in Review waits too", async () => {
      await oneCard({ ...hardaway, confidence: 0.5 });
      expect(statusOf(await oneCard(hardaway))[0]!.s).toBe("needs_review");
    });

    it("many cards in one photo: the owned card waits, the others are filed; two copies in one photo both wait", async () => {
      await oneCard(hardaway);
      const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
      await processScan(scanId, { db, recognizer: fake([
        { ...hardaway, sourceIndex: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
        { ...milacki, sourceIndex: 0, box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } },
      ]) });
      expect(statusOf(scanId)).toEqual([{ s: "needs_review", p: "Tim Hardaway" }, { s: "confirmed", p: "Bob Milacki" }]);
      const twice = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
      const ripken = { ...milacki, player: "Cal Ripken, Jr.", cardNumber: "22" };
      await processScan(twice.scanId, { db, recognizer: fake([
        { ...ripken, sourceIndex: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
        { ...ripken, sourceIndex: 0, box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } },
      ]) });
      expect(statusOf(twice.scanId).map((r) => r.s)).toEqual(["needs_review", "needs_review"]);
    });

    it("the number blank on one side: the same player, year and brand still waits (Mills)", async () => {
      const mills: RecognizedItemInput = { kind: "card", confidence: 0.93, sport: "other", year: 1991, brand: "Impel", cardNumber: "24", player: "Billy Mills", estimate: null };
      await oneCard(mills);
      expect(statusOf(await oneCard({ ...mills, cardNumber: null }))[0]!.s).toBe("needs_review");
    });

    it("a sold copy does not hold a new scan (only live items count)", async () => {
      const first = await oneCard(hardaway);
      const old = db.select().from(items).where(eq(items.scanId, first)).get()!;
      db.update(items).set({ status: "sold" }).where(eq(items.id, old.id)).run();
      expect(statusOf(await oneCard(hardaway))[0]!.s).toBe("confirmed");
    });
  });

  it("a card read from its back alone keeps its cut-out as its back photo, not as a front", async () => {
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }] }, db);
    const backOnly: Recognizer = {
      name: "fake-model",
      async recognize() {
        const read = recognizedItemSchema.parse({ ...griffey, sourceIndex: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } });
        return [{ ...read, cropSide: "back" as const }];
      },
    };
    await processScan(scanId, { db, recognizer: backOnly });
    const [card] = db.select().from(items).all();
    expect(db.select().from(images).where(eq(images.itemId, card.id)).all().map((i) => i.role)).toEqual(["back"]);
  });

  it("keeps a paired back from another photo of a many-card scan as that card's back photo (12R.7)", async () => {
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: await photo() }, { role: "source", data: await photo("#993333") }] }, db);
    const paired: Recognizer = {
      name: "fake-model",
      async recognize() {
        const front = recognizedItemSchema.parse({ ...griffey, sourceIndex: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } });
        const alone = recognizedItemSchema.parse({ ...griffey, player: "Bo Jackson", sourceIndex: 0, box: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } });
        return [{ ...front, backPhoto: { sourceIndex: 1, box: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 } } }, alone];
      },
    };
    await processScan(scanId, { db, recognizer: paired });
    const [first, second] = db.select().from(items).all();
    const roles = (id: number) => db.select().from(images).where(eq(images.itemId, id)).all().map((i) => i.role).sort();
    expect(roles(first.id)).toEqual(["back", "crop"]);
    expect(roles(second.id)).toEqual(["crop"]);
    const back = db.select().from(images).where(and(eq(images.role, "back"), eq(images.itemId, first.id))).get()!;
    expect((await readPhoto(back.file)).data.length).toBeGreaterThan(0);
    // Both original photos stay with the scan.
    expect(db.select().from(images).where(eq(images.role, "source")).all().every((i) => i.itemId === null)).toBe(true);
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
    await processScan(a.scanId, { db, recognizer: fake(new RecognitionError("The paid reading service is busy. Try again in a minute.")) });
    const b = await createScan({ mode: "single", photos: [{ role: "front", data: await photo() }] }, db);
    await processScan(b.scanId, { db, recognizer: fake(new Error("secret internal detail /var/lib/x")) });
    const [first, second] = db.select().from(scans).all();
    expect(first).toMatchObject({ status: "failed", error: "The paid reading service is busy. Try again in a minute." });
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

const KEY = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const filesOnDisk = () => {
  const count = (dir: string): number => fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(`${dir}/${e.name}`) : 1), 0)
    : 0;
  return count(uploadsDir());
};

describe("createScan with a clientKey", () => {
  it("first upload makes a scan and stores the key", async () => {
    const r = await createScan({ mode: "single", clientKey: KEY, photos: [{ role: "front", data: await photo() }] }, db);
    expect(r.duplicate).toBe(false);
    expect(db.select().from(scans).where(eq(scans.id, r.scanId)).get()!.clientKey).toBe(KEY);
  });

  it("the same key twice gives one scan, the same id and no new files", async () => {
    const photos = [{ role: "front" as const, data: await photo() }];
    const first = await createScan({ mode: "single", clientKey: KEY, photos }, db);
    const filesAfterFirst = filesOnDisk();
    const second = await createScan({ mode: "single", clientKey: KEY, photos }, db);
    expect(second).toEqual({ scanId: first.scanId, duplicate: true });
    expect(db.select().from(scans).all()).toHaveLength(1);
    expect(db.select().from(images).all()).toHaveLength(1);
    expect(filesOnDisk()).toBe(filesAfterFirst);
  });

  it("two repeats racing give one scan and leave no stray files", async () => {
    const photos = [{ role: "front" as const, data: await photo() }];
    const before = filesOnDisk();
    const [a, b] = await Promise.all([
      createScan({ mode: "single", clientKey: KEY, photos }, db),
      createScan({ mode: "single", clientKey: KEY, photos }, db),
    ]);
    expect(a.scanId).toBe(b.scanId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(db.select().from(scans).all()).toHaveLength(1);
    expect(db.select().from(images).all()).toHaveLength(1);
    // The files added equal what one lone upload adds: nothing from the loser remains.
    const raced = filesOnDisk() - before;
    const mid = filesOnDisk();
    await createScan({ mode: "single", photos }, db);
    expect(raced).toBeGreaterThan(0);
    expect(raced).toBe(filesOnDisk() - mid);
  });

  it("no key works as before, and two keyless scans stay separate", async () => {
    const photos = [{ role: "front" as const, data: await photo() }];
    const a = await createScan({ mode: "single", photos }, db);
    const b = await createScan({ mode: "single", photos }, db);
    expect(a.scanId).not.toBe(b.scanId);
    expect(a.duplicate).toBe(false);
  });
});

describe("scanStatusCounts", () => {
  it("counts scans by state and items needing review", () => {
    const mk = (status: "queued" | "processing" | "done" | "failed") => db.insert(scans).values({ mode: "single", status }).returning({ id: scans.id }).get().id;
    const done = mk("done");
    mk("queued"); mk("queued"); mk("processing"); mk("failed");
    const item = (status: "needs_review" | "confirmed") =>
      db.insert(items).values({ kind: "card", status, title: "x", scanId: done }).run();
    item("needs_review"); item("needs_review"); item("confirmed");
    expect(scanStatusCounts(db)).toEqual({ reading: 3, failed: 1, toReview: 2 });
  });

  it("is all zero on an empty database", () => {
    expect(scanStatusCounts(db)).toEqual({ reading: 0, failed: 0, toReview: 0 });
  });
});

describe("scanViews (many scans in one go)", () => {
  it("gives the same answer as getScanView for each scan, with places in line", () => {
    const mk = (status: "queued" | "processing" | "done" | "failed") => db.insert(scans).values({ mode: "single", status }).returning({ id: scans.id }).get().id;
    const ids = [mk("done"), mk("processing"), mk("queued"), mk("queued"), mk("failed"), mk("queued")];
    db.insert(items).values([
      { kind: "card", status: "confirmed", title: "a", scanId: ids[0] },
      { kind: "card", status: "needs_review", title: "b", scanId: ids[0] },
      { kind: "card", status: "confirmed", title: "c", scanId: ids[4] },
    ]).run();
    for (const order of [[], [ids[1]!, ids[5]!, ids[2]!], [ids[3]!, ids[2]!]]) {
      const many = scanViews([...ids].reverse(), db, order, 5);
      expect(many.map((v) => v.id)).toEqual(ids);
      expect(many).toEqual(ids.map((id) => getScanView(id, db, order, 5)));
    }
    expect(scanViews([], db)).toEqual([]);
    expect(scanViews([12345], db)).toEqual([]);
  });
});

describe("Scan activity data", () => {
  it("lists one scan in each state, newest first, with a small photo for scans that have one", async () => {
    const done = db.insert(scans).values({ mode: "single", status: "done" }).returning({ id: scans.id }).get().id;
    const failed = db.insert(scans).values({ mode: "single", status: "failed", error: "Could not read this photo." }).returning({ id: scans.id }).get().id;
    const processing = db.insert(scans).values({ mode: "single", status: "processing", startedAt: new Date() }).returning({ id: scans.id }).get().id;
    const queued = db.insert(scans).values({ mode: "single", status: "queued" }).returning({ id: scans.id }).get().id;
    db.insert(items).values({ kind: "card", status: "needs_review", title: "Check me", scanId: done }).run();
    db.insert(images).values({ scanId: done, role: "back", file: "b.jpg", thumbFile: "b-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    db.insert(images).values({ scanId: done, role: "front", file: "f.jpg", thumbFile: "f-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    const list = recentScans(50, db);
    expect(list.map((s) => [s.id, s.status])).toEqual([[queued, "queued"], [processing, "processing"], [failed, "failed"], [done, "done"]]);
    expect(list.find((s) => s.id === failed)!.error).toBe("Could not read this photo.");
    expect(list.find((s) => s.id === done)!.items.map((i) => [i.title, i.status])).toEqual([["Check me", "needs_review"]]);
    const thumbs = scanPhotoThumbs(list.map((s) => s.id), db);
    expect(thumbs.get(done)).toBe("f-t.jpg");
    expect(thumbs.has(queued)).toBe(false);
    expect(scanPhotoThumbs([], db).size).toBe(0);
  });
});
