import { describe, expect, it, vi } from "vitest";
import type { ScanView } from "@/lib/scans/view";
import { createScanStore, type ScanStoreDeps } from "./scan-store";

function view(id: number, status: ScanView["status"]): ScanView {
  return {
    id, mode: "single", status, error: status === "failed" ? "Bad photo" : null, itemCount: status === "done" ? 1 : 0, createdAt: 0,
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
  const deps: ScanStoreDeps = {
    fetch: ((url: string, init: RequestInit) => answer(url, init)) as unknown as typeof fetch,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return ++id; },
    setInterval: (fn) => { intervals.set(++id, fn); return id; },
    clearInterval: (i) => { intervals.delete(i as number); },
    now: () => 0,
    createObjectURL: () => { const u = `blob:${created.length + 1}`; created.push(u); return u; },
    revokeObjectURL: (u) => { revoked.push(u); },
    randomUUID: () => `00000000-0000-4000-8000-00000000000${created.length}`,
    notifySaved: () => { saved += 1; },
  };
  return { deps, timeouts, intervals, revoked, created, saved: () => saved };
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
      return Response.json(view(5, scanStatus));
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
    const b = fakeBrowser(async (url) => (url === "/api/scans" ? Response.json({ scanId: ++id }, { status: 201 }) : Response.json(poll)));
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
});
