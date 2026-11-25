import { describe, expect, it, vi } from "vitest";
import { MAX_BATCH_PHOTOS } from "@/lib/scans/batch-limits";
import { batchProgress, batchRoom, planBatch, progressLine, unsentKeys } from "./batch-plan";
import { batchCountsLine, retryResultLine } from "./BatchReportCard";
import { emptyQueue, MAX_QUEUE, queueReducer, type QueueState } from "./scan-queue";
import { createScanStore, type ScanStoreDeps } from "./scan-store";

describe("planBatch (Many photos, one card each)", () => {
  const photos = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

  it("fronts only: one card per photo, in the order picked", () => {
    expect(planBatch(photos(3), "fronts")).toEqual({ ok: true, cards: [{ front: "p1" }, { front: "p2" }, { front: "p3" }] });
  });

  it("front, back, front, back: pairs in the order picked", () => {
    expect(planBatch(photos(4), "pairs")).toEqual({ ok: true, cards: [{ front: "p1", back: "p2" }, { front: "p3", back: "p4" }] });
  });

  it("an odd number of photos for fronts and backs is refused in plain words", () => {
    const r = planBatch(photos(7), "pairs");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("pick an even number") });
  });

  it("takes up to 60 photos, never more", () => {
    expect(planBatch(photos(MAX_BATCH_PHOTOS), "fronts")).toMatchObject({ ok: true });
    expect(planBatch(photos(MAX_BATCH_PHOTOS), "pairs")).toMatchObject({ ok: true, cards: expect.any(Array) });
    expect(planBatch(photos(MAX_BATCH_PHOTOS + 1), "fronts")).toEqual({ ok: false, error: "You picked 61 photos. The limit is 60 at a time. Pick fewer." });
    expect(planBatch([], "fronts")).toMatchObject({ ok: false });
  });

  it("says plainly when the page's list has no room for all of them", () => {
    expect(planBatch(photos(10), "fronts", 4)).toEqual({ ok: false, error: expect.stringContaining("Only 4 more cards fit") });
    expect(planBatch(photos(10), "fronts", 0)).toEqual({ ok: false, error: expect.stringContaining("The list on this page is full") });
    expect(planBatch(photos(8), "pairs", 4)).toMatchObject({ ok: true });
  });
});

function withEntries(n: number, batch: string | null): QueueState {
  let s = emptyQueue;
  for (let i = 1; i <= n; i++) s = queueReducer(s, { type: "add", key: i, clientKey: `k${i}`, name: `n${i}`, previewUrl: `blob:${i}`, batch });
  return s;
}

describe("batch progress", () => {
  it("counts sent, not sent and still sending, per upload", () => {
    let s = withEntries(4, "b1");
    for (const key of [1, 2, 3, 4]) s = queueReducer(s, { type: "sending", key });
    s = queueReducer(s, { type: "uploaded", key: 1, scanId: 11, at: 0 });
    s = queueReducer(s, { type: "uploaded", key: 2, scanId: 12, at: 0 });
    s = queueReducer(s, { type: "uploadFailed", key: 3, message: "x", failure: "rejected" });
    expect(batchProgress(s)).toEqual([{ batch: "b1", total: 4, sent: 2, notSent: 1, sending: 1 }]);
    expect(progressLine(batchProgress(s)[0]!)).toBe("2 of 4 sent");
    expect(unsentKeys(s, "b1")).toEqual([3]);
    expect(unsentKeys(s, "other")).toEqual([]);
    expect(progressLine({ batch: "b1", total: 4, sent: 4, notSent: 0, sending: 0 })).toMatch(/^All 4 sent\./);
  });

  it("a scan saved on its own is no upload", () => {
    expect(batchProgress(withEntries(2, null))).toEqual([]);
  });

  it("room counts only entries not finished yet", () => {
    expect(batchRoom(emptyQueue)).toBe(MAX_QUEUE);
    let s = withEntries(3, "b1");
    s = queueReducer(s, { type: "sending", key: 1 });
    s = queueReducer(s, { type: "uploaded", key: 1, scanId: 9, at: 0 });
    expect(batchRoom(s)).toBe(MAX_QUEUE - 3);
  });
});

describe("batch report words", () => {
  it("counts line and retry line", () => {
    expect(batchCountsLine({ scans: 40, read: 30, waiting: 8, failed: 2 })).toBe("40 cards: 30 read, 8 waiting, 2 failed");
    expect(batchCountsLine({ scans: 1, read: 1, waiting: 0, failed: 0 })).toBe("1 card: 1 read, 0 waiting, 0 failed");
    expect(retryResultLine(2, 0)).toBe("2 cards are being read again.");
    expect(retryResultLine(1, 1)).toBe("1 card is being read again. 1 could not be tried again because its photos are gone; take it again.");
    expect(retryResultLine(0, 0)).toBe("Nothing to try again.");
  });
});

describe("scan store with an upload of many photos", () => {
  it("sends the upload id with every card; a lost connection never sends a saved card twice and the rest can be sent again", async () => {
    const bodies: FormData[] = [];
    let online = true;
    let next = 100;
    const timeouts: (() => void)[] = [];
    let n = 0;
    const deps: ScanStoreDeps = {
      fetch: (async (url: string, init: RequestInit) => {
        if (url === "/api/scans") {
          if (!online) throw new TypeError("offline");
          bodies.push(init.body as FormData);
          return Response.json({ scanId: next++ }, { status: 201 });
        }
        return Response.json({ reading: 0, failed: 0, toReview: 0, scans: [] });
      }) as unknown as typeof fetch,
      setTimeout: (fn) => { timeouts.push(fn); return 1; },
      setInterval: () => 1,
      clearInterval: () => undefined,
      now: () => 0,
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: () => undefined,
      randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      notifySaved: () => undefined,
      isVisible: () => true,
      onVisibilityChange: () => undefined,
    };
    const store = createScanStore(deps);
    const batchKey = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    const card = (i: number) => ({ mode: "single", hint: "", locationId: "", front: new File([`f${i}`], `f${i}.jpg`), back: new File([`b${i}`], `b${i}.jpg`), source: [], batchKey });
    store.enqueue(card(1), new Blob(["x"]), "Card 1 of 3");
    store.enqueue(card(2), new Blob(["x"]), "Card 2 of 3");
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    online = false;
    store.enqueue(card(3), new Blob(["x"]), "Card 3 of 3");
    // Three automatic tries, then it waits for the owner.
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(timeouts.length).toBe(i + 1));
      timeouts[i]!();
    }
    await vi.waitFor(() => expect(store.getState().entries[2]!.status).toBe("failed"));
    expect(batchProgress(store.getState())).toEqual([{ batch: batchKey, total: 3, sent: 2, notSent: 1, sending: 0 }]);
    expect(bodies.every((b) => b.get("batchKey") === batchKey && b.get("front") instanceof File && b.get("back") instanceof File)).toBe(true);

    online = true;
    for (const key of unsentKeys(store.getState(), batchKey)) await store.retry(key);
    await vi.waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]!.get("front")).toMatchObject({ name: "f3.jpg" });
    await vi.waitFor(() => expect(batchProgress(store.getState())).toEqual([{ batch: batchKey, total: 3, sent: 3, notSent: 0, sending: 0 }]));
    // Nothing more to send: the cards already saved were never sent again.
    expect(unsentKeys(store.getState(), batchKey)).toEqual([]);
    expect(new Set(bodies.map((b) => b.get("clientKey"))).size).toBe(3);
  });
});
