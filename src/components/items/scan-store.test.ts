import { describe, expect, it, vi } from "vitest";
import type { ScanView } from "@/lib/scans/view";
import { nextStatusAskMs } from "@/components/nav/scan-status-poll";
import { MAX_QUEUE, SIGNED_OUT_MESSAGE } from "./scan-queue";
import { createScanStore, POLL_MS, type ScanStoreDeps } from "./scan-store";

/** The batched status route's answer for these scans. */
const statusAnswer = (views: ScanView[]) => Response.json({ reading: views.length, failed: 0, toReview: 0, scans: views });
/** The scan ids a status ask was about. */
const idsOf = (url: string) => (new URL(url, "http://x").searchParams.get("ids") ?? "").split(",").map(Number);

function view(id: number, status: ScanView["status"]): ScanView {
  return {
    id, mode: "single", status, error: status === "failed" ? "Bad photo" : null, itemCount: status === "done" ? 1 : 0, inBin: 0, createdAt: 0,
    startedAt: status === "queued" ? null : 0, queuePosition: status === "queued" ? 1 : null, serverTime: 0,
    items: (status === "done" ? [{ id: 1, status: "confirmed" }] : []) as unknown as ScanView["items"],
  };
}

/** Fake browser: timers run only when the test says so, fetch answers come from `answer`. */
function fakeBrowser(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals = new Map<number, () => void>();
  let id = 0;
  const revoked: string[] = [];
  const created: string[] = [];
  let saved = 0;
  let visible = true;
  let clock = 0;
  const onVisible: (() => void)[] = [];
  const deps: ScanStoreDeps = {
    fetch: ((url: string, init: RequestInit) => answer(url, init)) as unknown as typeof fetch,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return ++id; },
    setInterval: (fn) => { intervals.set(++id, fn); return id; },
    clearInterval: (i) => { intervals.delete(i as number); },
    now: () => clock,
    createObjectURL: () => { const u = `blob:${created.length + 1}`; created.push(u); return u; },
    revokeObjectURL: (u) => { revoked.push(u); },
    randomUUID: () => `00000000-0000-4000-8000-00000000000${created.length}`,
    notifySaved: () => { saved += 1; },
    isVisible: () => visible,
    onVisibilityChange: (fn) => { onVisible.push(fn); },
  };
  const setVisible = (v: boolean) => { visible = v; for (const fn of onVisible) fn(); };
  const setClock = (ms: number) => { clock = ms; };
  return { deps, timeouts, intervals, revoked, created, saved: () => saved, setVisible, setClock };
}

const photo = () => new Blob(["x"], { type: "image/jpeg" });
const job = { mode: "single", hint: "", locationId: "", front: new File(["x"], "f.jpg"), source: [] };

describe("scan store (the list shared by every page)", () => {
  it("keeps uploading and keeps the list when the scan screen goes away and comes back", async () => {
    let posts = 0;
    let scanStatus: ScanView["status"] = "processing";
    const b = fakeBrowser(async (url) => {
      if (url === "/api/scans") {
        posts += 1;
        if (posts === 1) throw new TypeError("offline");
        return Response.json({ scanId: 5 }, { status: 201 });
      }
      return statusAnswer([view(5, scanStatus)]);
    });
    const store = createScanStore(b.deps);

    // The scan screen is open: it listens to the store.
    const screen = vi.fn();
    const leave = store.subscribe(screen);
    expect(store.enqueue(job, photo(), "One card")).toBe(true);
    // The owner taps another page: the screen stops listening. The store carries on.
    leave();

    await vi.waitFor(() => expect(store.getState().entries[0].status).toBe("backoff"));
    expect(b.timeouts[0].ms).toBe(2000);
    b.timeouts[0].fn();
    await vi.waitFor(() => expect(store.getState().entries[0].status).toBe("reading"));
    expect(posts).toBe(2);
    expect(b.saved()).toBe(1);
    // Polling runs while a scan is being read, without any screen open.
    expect(b.intervals.size).toBe(1);

    // The owner comes back to the scan screen: the same entry is there.
    const back = vi.fn();
    store.subscribe(back);
    expect(store.getState().entries).toHaveLength(1);
    expect(store.getState().entries[0]).toMatchObject({ scanId: 5, previewUrl: "blob:1" });

    scanStatus = "done";
    await store.poll();
    expect(store.getState().entries[0].status).toBe("done");
    expect(back).toHaveBeenCalled();
    // Read: the preview is freed and polling stops.
    expect(b.revoked).toEqual(["blob:1"]);
    expect(store.getState().entries[0].previewUrl).toBeNull();
    expect(b.intervals.size).toBe(0);
  });

  it("sends the same clientKey on every try", async () => {
    const keys: string[] = [];
    let n = 0;
    const b = fakeBrowser(async (_url, init) => {
      keys.push((init.body as FormData).get("clientKey") as string);
      n += 1;
      return n < 3 ? Response.json({ error: "Busy" }, { status: 503 }) : Response.json({ scanId: 1 }, { status: 201 });
    });
    const store = createScanStore(b.deps);
    store.enqueue(job, photo(), "One card");
    await vi.waitFor(() => expect(b.timeouts).toHaveLength(1));
    b.timeouts[0].fn();
    await vi.waitFor(() => expect(b.timeouts).toHaveLength(2));
    b.timeouts[1].fn();
    await vi.waitFor(() => expect(store.getState().entries[0].status).toBe("reading"));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("frees the preview when the server refuses the photo for good, and keeps it for Retry otherwise", async () => {
    let status = 413;
    const b = fakeBrowser(async () => Response.json(status === 201 ? { scanId: 7 } : { error: "Too large" }, { status }));
    const store = createScanStore(b.deps);
    store.enqueue(job, photo(), "One card");
    await vi.waitFor(() => expect(store.getState().entries[0].status).toBe("failed"));
    expect(store.getState().entries[0]).toMatchObject({ error: "Too large", previewUrl: null, attempt: 0 });
    expect(b.revoked).toEqual(["blob:1"]);

    status = 401;
    store.enqueue(job, photo(), "One card");
    await vi.waitFor(() => expect(store.getState().entries[1].status).toBe("failed"));
    expect(store.getState().entries[1]).toMatchObject({ failure: "signIn", previewUrl: "blob:2" });
    expect(b.revoked).toEqual(["blob:1"]);
    // After signing in, Retry sends it again.
    status = 201;
    await store.retry(store.getState().entries[1].key);
    await vi.waitFor(() => expect(store.getState().entries[1].status).toBe("reading"));
  });

  it("frees the preview when the scan fails on the server or the page stops waiting", async () => {
    let poll: ScanView = view(1, "failed");
    let id = 0;
    const b = fakeBrowser(async (url) => (url === "/api/scans" ? Response.json({ scanId: ++id }, { status: 201 }) : statusAnswer([poll])));
    const store = createScanStore(b.deps);
    store.enqueue(job, photo(), "a");
    await vi.waitFor(() => expect(store.getState().entries[0].status).toBe("reading"));
    await store.poll();
    expect(store.getState().entries[0].status).toBe("failed");
    expect(b.revoked).toEqual(["blob:1"]);

    // Being read for over 6 minutes by the server's clock: the page stops waiting.
    poll = { ...view(2, "processing"), startedAt: 0, serverTime: 7 * 60 * 1000 };
    store.enqueue(job, photo(), "b");
    await vi.waitFor(() => expect(store.getState().entries[1].status).toBe("reading"));
    await store.poll(); // learns the start time
    await store.poll(); // gives up
    expect(store.getState().entries[1]).toMatchObject({ status: "failed", previewUrl: null });
    expect(b.revoked).toEqual(["blob:1", "blob:2"]);
    expect(b.intervals.size).toBe(0);
  });

  it("when the list is full it drops the oldest finished entry, never one that is not saved", async () => {
    let id = 0;
    const b = fakeBrowser(async (url) => {
      if (url === "/api/scans") return Response.json({ scanId: ++id }, { status: 201 });
      return statusAnswer(idsOf(url).map((i) => view(i, "done")));
    });
    const store = createScanStore(b.deps);
    for (let i = 0; i < MAX_QUEUE; i++) expect(store.enqueue(job, photo(), `s${i}`)).toBe(true);
    await vi.waitFor(() => expect(store.getState().entries.every((e) => e.status === "reading")).toBe(true));
    // All still being read: nothing may be dropped, so the 101st is refused.
    expect(store.enqueue(job, photo(), "extra")).toBe(false);
    expect(store.getState().entries).toHaveLength(MAX_QUEUE);
    await store.poll();
    expect(store.getState().entries.every((e) => e.status === "done")).toBe(true);
    const oldest = store.getState().entries[0].key;
    expect(store.enqueue(job, photo(), "new")).toBe(true);
    const keys = store.getState().entries.map((e) => e.key);
    expect(keys).toHaveLength(MAX_QUEUE);
    expect(keys).not.toContain(oldest);
    expect(keys[keys.length - 1]).toBe(MAX_QUEUE + 1);
  });

  describe("asking about scans being read", () => {
    /** A store with `n` saved scans being read; every status ask is recorded. */
    async function readingStore(n: number, answer?: (url: string) => Response) {
      const asks: string[] = [];
      let id = 0;
      const b = fakeBrowser(async (url) => {
        if (url === "/api/scans") return Response.json({ scanId: ++id }, { status: 201 });
        asks.push(url);
        return answer ? answer(url) : statusAnswer(idsOf(url).map((i) => view(i, "processing")));
      });
      const store = createScanStore(b.deps);
      for (let i = 0; i < n; i++) store.enqueue(job, photo(), `s${i}`);
      await vi.waitFor(() => expect(store.getState().entries.every((e) => e.status === "reading")).toBe(true));
      return { b, store, asks };
    }

    it("makes one request per round for all scans, every 5 seconds", async () => {
      const { b, asks } = await readingStore(30);
      expect(POLL_MS).toBe(5000);
      expect(b.intervals.size).toBe(1);
      [...b.intervals.values()][0]!();
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      expect(asks[0]!.startsWith("/api/scans/status?ids=")).toBe(true);
      expect(idsOf(asks[0]!)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });

    it("shares the counts with the pill, which then has no timer of its own", async () => {
      const { store } = await readingStore(2);
      await store.poll();
      const shared = store.getStatus();
      expect(shared).toMatchObject({ counts: { reading: 2, failed: 0, toReview: 0 }, polling: true, signedOut: false });
      expect(nextStatusAskMs(2, false, shared)).toBeNull();
    });

    it("asks nothing while the tab is hidden, and once at once when it comes back", async () => {
      const { b, store, asks } = await readingStore(3);
      b.setVisible(false);
      expect(b.intervals.size).toBe(0);
      expect(store.getStatus().polling).toBe(false);
      await store.poll();
      expect(asks).toHaveLength(0);
      b.setVisible(true);
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      expect(b.intervals.size).toBe(1);
    });

    it("stops after 3 'not signed in' answers in a row, says so, and carries on once signed in again", async () => {
      let status = 401;
      const { b, store, asks } = await readingStore(2, (url) =>
        status === 401 ? Response.json({ error: "Please sign in." }, { status: 401 }) : statusAnswer(idsOf(url).map((i) => view(i, "done"))),
      );
      await store.poll();
      await store.poll();
      expect(b.intervals.size).toBe(1);
      expect(store.getState().entries.some((e) => e.signedOut)).toBe(false);
      await store.poll();
      expect(asks).toHaveLength(3);
      expect(b.intervals.size).toBe(0);
      expect(store.getState().entries.every((e) => e.signedOut && e.status === "reading")).toBe(true);
      expect(store.getStatus().signedOut).toBe(true);
      expect(SIGNED_OUT_MESSAGE).toBe("Signed out. Sign in again in a new tab, then come back; your photos stay here.");
      // The owner signs in in another tab and comes back: one ask at once, and it works.
      status = 200;
      b.setVisible(false);
      b.setVisible(true);
      await vi.waitFor(() => expect(store.getState().entries.every((e) => e.status === "done")).toBe(true));
      expect(asks).toHaveLength(4);
      expect(store.getState().entries.some((e) => e.signedOut)).toBe(false);
      expect(store.getStatus().signedOut).toBe(false);
    });

    it("a different error breaks the row of 'not signed in' answers", async () => {
      const codes = [401, 401, 500, 401, 401];
      const { b, store } = await readingStore(1, () => Response.json({}, { status: codes.shift() ?? 200 }));
      for (let i = 0; i < 5; i++) await store.poll();
      expect(store.getStatus().signedOut).toBe(false);
      expect(b.intervals.size).toBe(1);
    });

    it("stops asking about a scan still waiting in line 6 minutes after it was saved", async () => {
      const { b, store, asks } = await readingStore(1, (url) => statusAnswer(idsOf(url).map((i) => view(i, "queued"))));
      await store.poll();
      expect(asks).toHaveLength(1);
      b.setClock(6 * 60 * 1000 + 1);
      await store.poll();
      expect(asks).toHaveLength(1);
      expect(store.getState().entries[0]).toMatchObject({ status: "failed", scanId: 1 });
      expect(b.intervals.size).toBe(0);
    });
  });
});

describe("a repeat after the page was closed", () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: "image/jpeg" });
  const sendJob = { mode: "single", hint: "", locationId: "", front: file("IMG_1.jpg", 10), source: [] as File[] };
  type Memory = Record<string, { clientKey: string; at: number }>;
  const memoryStore = () => {
    let memory: Memory = {};
    return { read: () => structuredClone(memory), write: (all: Memory) => { memory = structuredClone(all); } };
  };
  const hang = () => new Promise<Response>(() => {});

  it("reuses the key of a photo that was sent but never confirmed, so no second scan is made", async () => {
    const pending = memoryStore();
    const keys: string[] = [];
    // The first page: the photo reaches the server but the answer never comes back (page closed).
    const b1 = fakeBrowser(async (_u, init) => { keys.push((init.body as FormData).get("clientKey") as string); return hang(); });
    createScanStore({ ...b1.deps, pending }).enqueue(sendJob, photo(), "One card");
    await vi.waitFor(() => expect(keys).toHaveLength(1));

    // The page is loaded again and the owner picks the same photo.
    const b2 = fakeBrowser(async (_u, init) => { keys.push((init.body as FormData).get("clientKey") as string); return Response.json({ scanId: 3 }, { status: 201 }); });
    const store2 = createScanStore({ ...b2.deps, randomUUID: () => "11111111-1111-4111-8111-111111111111", pending });
    store2.enqueue(sendJob, photo(), "One card");
    await vi.waitFor(() => expect(store2.getState().entries[0].status).toBe("reading"));
    expect(keys[1]).toBe(keys[0]);

    // Once the server has confirmed it, the same photo taken on purpose again is a new scan.
    store2.enqueue(sendJob, photo(), "One card");
    await vi.waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("makes two scans of the same photo on one page, and forgets a remembered send after 30 minutes", async () => {
    const pending = memoryStore();
    const keys: string[] = [];
    const b = fakeBrowser(async (_u, init) => { keys.push((init.body as FormData).get("clientKey") as string); return hang(); });
    let n = 0;
    const store = createScanStore({ ...b.deps, randomUUID: () => `00000000-0000-4000-8000-00000000000${++n}`, pending });
    store.enqueue(sendJob, photo(), "One card");
    store.enqueue(sendJob, photo(), "One card");
    await vi.waitFor(() => expect(new Set(keys).size).toBe(2));

    const b2 = fakeBrowser(async (_u, init) => { keys.push((init.body as FormData).get("clientKey") as string); return hang(); });
    b2.setClock(31 * 60 * 1000);
    createScanStore({ ...b2.deps, randomUUID: () => "22222222-2222-4222-8222-222222222222", pending }).enqueue(sendJob, photo(), "One card");
    await vi.waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).toBe("22222222-2222-4222-8222-222222222222");
  });
});
