import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { images, items, outsideState, outsideUsage, scans } from "@/db/schema";
import { serializeCatalog } from "@/lib/catalog/candidates";
import { utcDay } from "@/lib/outside/usage";
import { recognizedItemSchema, RecognitionError, type RecognizedItemInput, type Recognizer } from "@/lib/recognition/types";
import { batchReports, catalogLimitNow, catalogLimitText, catalogSkippedText, retryBatch } from "./batch";
import { createScan } from "./create";
import { processScan, queueIdle, recoverScans } from "./process";

const B1 = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const B2 = "7f9619ff-8b86-4011-b42d-00c04fc964ff";

const jpeg = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#224466" } }).jpeg().toBuffer();

function reader(result: RecognizedItemInput[] | Error, seen?: number[]): Recognizer {
  return {
    name: "fake-model",
    async recognize(req) {
      seen?.push(req.photos.length);
      if (result instanceof Error) throw result;
      return result.map((r) => recognizedItemSchema.parse(r));
    },
  };
}

const card: RecognizedItemInput = {
  kind: "card", confidence: 0.6, sport: "baseball", year: 1989, brand: "Topps", cardNumber: "1", player: "Ken Griffey Jr.", estimate: null,
};

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

async function scanIn(batchKey: string | null, back = true) {
  const photos = [{ role: "front" as const, data: await jpeg() }, ...(back ? [{ role: "back" as const, data: await jpeg() }] : [])];
  return (await createScan({ mode: "single", batchKey, photos }, db)).scanId;
}

describe("batch reports", () => {
  it("counts read, waiting and failed per upload, newest upload first; single scans are no upload", async () => {
    const a = [await scanIn(B1), await scanIn(B1), await scanIn(B1), await scanIn(B1)];
    await scanIn(null);
    const b = await scanIn(B2, false);
    await processScan(a[0]!, { db, recognizer: reader([card]) });
    await processScan(a[1]!, { db, recognizer: reader([{ ...card, confidence: 0.99 }]) });
    await processScan(a[2]!, { db, recognizer: reader(new RecognitionError("No card found in this photo.")) });
    const reports = batchReports(db);
    expect(reports.map((r) => r.key)).toEqual([B2, B1]);
    expect(reports[1]).toMatchObject({ scans: 4, read: 2, waiting: 1, failed: 1, retryable: 1, inReview: 1, catalogSkipped: 0 });
    expect(reports[0]).toMatchObject({ scans: 1, read: 0, waiting: 1, failed: 0 });
    expect(reports[1]!.startedAt).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("counts cards whose catalog check was skipped by a limit", async () => {
    const id = await scanIn(B1);
    await processScan(id, { db, recognizer: reader([card]) });
    const item = db.select().from(items).get()!;
    db.update(items).set({ catalogCandidates: serializeCatalog({ status: "not_checked", reason: "cap" }, new Date()) }).where(eq(items.id, item.id)).run();
    expect(batchReports(db)[0]).toMatchObject({ catalogSkipped: 1 });
    expect(catalogSkippedText(1)).toBe("1 card was read but not checked against the catalog because of its limit. Open it later and tap Look up again.");
    expect(catalogSkippedText(0)).toBeNull();
  });
});

describe("retryBatch (Try the failed ones again)", () => {
  it("queues only the failed scans of that upload; read cards are never read again", async () => {
    const ok = await scanIn(B1);
    const bad1 = await scanIn(B1);
    const bad2 = await scanIn(B1);
    const other = await scanIn(B2);
    await processScan(ok, { db, recognizer: reader([card]) });
    for (const id of [bad1, bad2, other]) await processScan(id, { db, recognizer: reader(new RecognitionError("Try again.")) });
    // One failed scan has lost its photos.
    db.delete(images).where(eq(images.scanId, bad2)).run();

    const r = retryBatch(B1, db);
    expect(r).toEqual({ ok: true, queued: [bad1], gone: 1 });
    const status = (id: number) => db.select({ s: scans.status }).from(scans).where(eq(scans.id, id)).get()!.s;
    expect([status(ok), status(bad1), status(bad2), status(other)]).toEqual(["done", "queued", "failed", "failed"]);

    const seen: number[] = [];
    await processScan(bad1, { db, recognizer: reader([card], seen) });
    expect(seen).toEqual([2]);
    expect(status(bad1)).toBe("done");
    // The read card still has exactly its one item.
    expect(db.select().from(items).where(eq(items.scanId, ok)).all()).toHaveLength(1);
    expect(retryBatch(B1, db)).toEqual({ ok: true, queued: [], gone: 1 });
    expect(retryBatch("8f9619ff-8b86-4011-b42d-00c04fc964ff", db)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the queue with many waiting scans", () => {
  it("40 cards waiting and 2 cut off mid-read by a restart are all read, one at a time, in order", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 42; i++) ids.push(await scanIn(B1, false));
    // A restart while two were being read: they were left "processing" long ago.
    db.update(scans).set({ status: "processing", startedAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(scans.id, ids[0]!)).run();
    db.update(scans).set({ status: "processing", startedAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(scans.id, ids[1]!)).run();
    let running = 0;
    let most = 0;
    const slow: Recognizer = {
      name: "fake-model",
      async recognize() {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 1));
        running -= 1;
        return [recognizedItemSchema.parse(card)];
      },
    };
    const spy = vi.spyOn(slow, "recognize");
    recoverScans({ db, recognizer: slow });
    // Asking again while they run changes nothing (no scan is queued twice).
    recoverScans({ db, recognizer: slow });
    await queueIdle();
    expect(db.select({ s: scans.status }).from(scans).all().every((s) => s.s === "done")).toBe(true);
    expect(db.select().from(items).all()).toHaveLength(42);
    expect(most).toBe(1);
    expect(spy).toHaveBeenCalledTimes(42);
    expect(batchReports(db)[0]).toMatchObject({ scans: 42, read: 42, waiting: 0, failed: 0 });
    // The order of reading is the order the cards were saved.
    const made = db.select({ scanId: items.scanId }).from(items).orderBy(items.id).all().map((r) => r.scanId);
    expect(made).toEqual([...ids].sort((x, y) => x - y));
  });
});

describe("catalog limits, said plainly", () => {
  it("off, paused and today's limit", () => {
    expect(catalogLimitNow(db)).toBeNull();
    db.insert(outsideState).values({ source: "mycardfolio", enabled: false }).run();
    expect(catalogLimitNow(db)).toEqual({ kind: "off" });
    db.update(outsideState).set({ enabled: true, pausedUntil: new Date(Date.now() + 60_000), lastError: "Slow down" }).run();
    expect(catalogLimitNow(db)).toMatchObject({ kind: "paused" });
    db.update(outsideState).set({ pausedUntil: null }).run();
    db.insert(outsideUsage).values({ source: "mycardfolio", day: utcDay(Date.now()), calls: 1000 }).run();
    expect(catalogLimitNow(db)).toEqual({ kind: "day" });
    for (const kind of ["off", "paused", "hour", "day"] as const) {
      const text = catalogLimitText(kind === "paused" ? { kind, untilMs: 0 } : { kind });
      expect(text).toMatch(/Cards are still read/);
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

// ---- Routes ----

const signedIn = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/auth/guard", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/guard")>();
  return { ...real, guardApi: (r: Request) => (signedIn.value ? Promise.resolve(null) : real.guardApi(r)) };
});
vi.mock("@/lib/scans/process", async (orig) => {
  const real = await orig<typeof import("@/lib/scans/process")>();
  return { ...real, enqueueScan: vi.fn(real.enqueueScan), recoverScans: vi.fn(real.recoverScans) };
});

describe("batch routes", () => {
  beforeEach(() => {
    signedIn.value = true;
    setDbForTests(db);
  });

  async function post(form: Record<string, string>) {
    const { POST } = await import("@/app/api/scans/route");
    const body = new FormData();
    body.set("mode", "single");
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    body.set("front", new File([new Uint8Array(await jpeg())], "a.jpg", { type: "image/jpeg" }));
    return POST(new Request("http://localhost/api/scans", { method: "POST", body }));
  }

  it("POST /api/scans keeps the upload id; a bad one is refused and saves nothing", async () => {
    const { enqueueScan: queued } = await import("@/lib/scans/process");
    vi.mocked(queued).mockImplementation(() => undefined);
    expect((await post({ batchKey: B1 })).status).toBe(201);
    expect(db.select({ k: scans.batchKey }).from(scans).all()).toEqual([{ k: B1 }]);
    expect((await post({ batchKey: "not-a-key" })).status).toBe(400);
    expect(db.select().from(scans).all()).toHaveLength(1);
  });

  it("GET /api/scans/batches reports; both routes need the owner session", async () => {
    const { GET } = await import("@/app/api/scans/batches/route");
    const { POST: RETRY } = await import("@/app/api/scans/batches/retry/route");
    const { recoverScans: recover } = await import("@/lib/scans/process");
    vi.mocked(recover).mockImplementation(() => undefined);
    await scanIn(B1);
    const res = await GET(new Request("http://localhost/api/scans/batches"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ batches: [{ key: B1, scans: 1, waiting: 1 }], catalogLimit: null });
    signedIn.value = false;
    expect((await GET(new Request("http://localhost/api/scans/batches"))).status).toBe(401);
    const retry = await RETRY(new Request("http://localhost/api/scans/batches/retry", { method: "POST", body: JSON.stringify({ batchKey: B1 }) }));
    expect(retry.status).toBe(401);
  });

  it("POST /api/scans/batches/retry checks its input and queues only the failed ones", async () => {
    const { POST: RETRY } = await import("@/app/api/scans/batches/retry/route");
    const { enqueueScan: queued } = await import("@/lib/scans/process");
    vi.mocked(queued).mockImplementation(() => undefined);
    vi.mocked(queued).mockClear();
    const send = (body: string) => RETRY(new Request("http://localhost/api/scans/batches/retry", { method: "POST", body }));
    for (const body of ["nope", "{}", JSON.stringify({ batchKey: "x" }), JSON.stringify({ batchKey: B1, extra: 1 })]) {
      expect((await send(body)).status).toBe(400);
    }
    expect((await send(JSON.stringify({ batchKey: B1 }))).status).toBe(404);
    const ok = await scanIn(B1);
    const bad = await scanIn(B1);
    await processScan(ok, { db, recognizer: reader([card]) });
    await processScan(bad, { db, recognizer: reader(new RecognitionError("Try again.")) });
    const res = await send(JSON.stringify({ batchKey: B1 }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: 1, gone: 0, batch: { key: B1, read: 1, waiting: 1, failed: 0 } });
    expect(vi.mocked(queued).mock.calls.map((c) => c[0])).toEqual([bad]);
  });
});
