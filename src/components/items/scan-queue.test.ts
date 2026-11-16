import { describe, expect, it, vi } from "vitest";
import type { ScanView } from "@/lib/scans/view";
import {
  atCap, isFinished, listFull, buildScanBody, canRelease, createUploader, emptyQueue, entryState, failureFor, hasUnsaved, KEEP_OPEN_MESSAGE, liveText, postScan, RETRY_DELAYS_MS, retryDelayMs, type ScanJob, type SendResult, GIVE_UP_AFTER_START_MS, MAX_QUEUE, nextToSend, queueReducer, retryKind, scanTimedOut, summary, summaryText,
  maySignOut, queuedTooLong, SIGN_OUT_QUESTION, TIMEOUT_MESSAGE, UPLOAD_TIMEOUT_MESSAGE, UPLOAD_TIMEOUT_MS, waitingText, type QueueAction, type QueueState, type UploadFailure,
} from "./scan-queue";

function run(actions: QueueAction[], from: QueueState = emptyQueue): QueueState {
  return actions.reduce(queueReducer, from);
}
const add = (key: number): QueueAction => ({ type: "add", key, clientKey: `k${key}`, name: `p${key}.jpg`, previewUrl: null });
function view(id: number, status: ScanView["status"], itemStatuses: string[] = []): ScanView {
  return {
    id, mode: "single", status, error: status === "failed" ? "Bad photo" : null, itemCount: itemStatuses.length, inBin: 0, createdAt: 0,
    startedAt: status === "queued" ? null : 0, queuePosition: status === "queued" ? 1 : null, serverTime: 0,
    items: itemStatuses.map((s, i) => ({ id: i + 1, status: s })) as unknown as ScanView["items"],
  };
}

describe("queueReducer", () => {
  it("adds in order and starts waiting", () => {
    const s = run([add(1), add(2)]);
    expect(s.entries.map((e) => e.key)).toEqual([1, 2]);
    expect(s.entries.every((e) => e.status === "waiting")).toBe(true);
  });

  it("sends at most 2 at a time, oldest first", () => {
    let s = run([add(1), add(2), add(3), add(4)]);
    expect(nextToSend(s, 2)).toEqual([1, 2]);
    s = run([{ type: "sending", key: 1 }], s);
    expect(nextToSend(s, 2)).toEqual([2]);
    s = run([{ type: "sending", key: 2 }], s);
    expect(nextToSend(s, 2)).toEqual([]);
    s = run([{ type: "uploaded", key: 1, scanId: 10, at: 1 }], s);
    expect(nextToSend(s, 2)).toEqual([3]);
  });

  it("moves through sending, reading and done", () => {
    const s = run([
      add(1),
      { type: "sending", key: 1 },
      { type: "uploaded", key: 1, scanId: 7, at: 5 },
      { type: "update", scan: view(7, "processing") },
    ]);
    expect(s.entries[0].status).toBe("reading");
    const d = run([{ type: "update", scan: view(7, "done", ["ok"]) }], s);
    expect(d.entries[0].status).toBe("done");
    expect(d.entries[0].scan?.id).toBe(7);
  });

  it("fails an upload and retries it", () => {
    let s = run([add(1), { type: "sending", key: 1 }, { type: "failed", key: 1, message: "Nope" }]);
    expect(s.entries[0]).toMatchObject({ status: "failed", error: "Nope" });
    expect(nextToSend(s, 2)).toEqual([]);
    s = run([{ type: "retry", key: 1 }], s);
    expect(s.entries[0]).toMatchObject({ status: "waiting", error: null });
    expect(nextToSend(s, 2)).toEqual([1]);
  });

  it("marks a failed scan result as failed with its error", () => {
    const s = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 3, at: 0 }, { type: "update", scan: view(3, "failed") }]);
    expect(s.entries[0]).toMatchObject({ status: "failed", error: "Bad photo" });
  });

  it("times out only a scan that is still reading", () => {
    const base = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 3, at: 0 }]);
    expect(run([{ type: "timeout", key: 1 }], base).entries[0]).toMatchObject({ status: "failed", error: TIMEOUT_MESSAGE });
    const done = run([{ type: "update", scan: view(3, "done") }], base);
    expect(run([{ type: "timeout", key: 1 }], done).entries[0].status).toBe("done");
  });

  it("ignores updates for unknown scans", () => {
    const s = run([add(1)]);
    expect(run([{ type: "update", scan: view(99, "done") }], s)).toBe(s);
  });

  it("caps the list at 100", () => {
    const s = run(Array.from({ length: MAX_QUEUE + 5 }, (_, i) => add(i + 1)));
    expect(s.entries).toHaveLength(MAX_QUEUE);
    expect(atCap(s)).toBe(true);
    expect(atCap(emptyQueue)).toBe(false);
  });
});

describe("a photo refused for good", () => {
  const refused = () => run([add(1), { type: "sending", key: 1 }, { type: "uploadFailed", key: 1, message: "Too large.", failure: "final" }]);
  it("does not keep the leave warning on", () => {
    const s = refused();
    expect(s.entries[0].status).toBe("failed");
    expect(hasUnsaved(s)).toBe(false);
  });
  it("counts as finished, so a full list can drop it", () => {
    expect(isFinished(refused().entries[0])).toBe(true);
  });
});

describe("full list drops only finished entries", () => {
  const saved = (k: number): QueueAction[] => [add(k), { type: "sending", key: k }, { type: "uploaded", key: k, scanId: k, at: 0 }];
  const fill = (n: number) => Array.from({ length: n }, (_, i) => saved(i + 1)).flat();

  it("knows what is finished: read, or failed on the server; nothing else", () => {
    const s = run([...fill(4), { type: "update", scan: view(1, "done") }, { type: "update", scan: view(2, "failed") }, { type: "timeout", key: 3 }, add(5)]);
    expect(s.entries.map(isFinished)).toEqual([true, true, false, false, false]);
  });

  it("makeRoom does nothing below the limit", () => {
    const s = run([...fill(2), { type: "update", scan: view(1, "done") }]);
    expect(run([{ type: "makeRoom" }], s)).toBe(s);
  });

  it("makeRoom drops the oldest finished entry and skips unfinished ones", () => {
    const s = run([...fill(MAX_QUEUE), { type: "update", scan: view(2, "done") }, { type: "update", scan: view(3, "failed") }]);
    expect(listFull(s)).toBe(false);
    const a = run([{ type: "makeRoom" }], s);
    expect(a.entries).toHaveLength(MAX_QUEUE - 1);
    expect(a.entries.some((e) => e.key === 2)).toBe(false);
    expect(a.entries.some((e) => e.key === 1)).toBe(true);
    const b = run([{ type: "makeRoom" }], { entries: [...a.entries, ...run(saved(500)).entries] });
    expect(b.entries.some((e) => e.key === 3)).toBe(false);
  });

  it("never drops an entry that is not saved or still being read", () => {
    const unsaved = run([...Array.from({ length: MAX_QUEUE }, (_, i) => add(i + 1)), { type: "sending", key: 1 }, { type: "failed", key: 1, message: "x" }]);
    expect(listFull(unsaved)).toBe(true);
    expect(run([{ type: "makeRoom" }], unsaved)).toBe(unsaved);
    const reading = run(fill(MAX_QUEUE));
    expect(run([{ type: "makeRoom" }], reading)).toBe(reading);
  });
});

describe("summary", () => {
  it("counts and formats", () => {
    const actions: QueueAction[] = [];
    for (let k = 1; k <= 6; k++) actions.push(add(k), { type: "sending", key: k }, { type: "uploaded", key: k, scanId: k, at: 0 });
    actions.push({ type: "update", scan: view(1, "done", ["ok"]) });
    actions.push({ type: "update", scan: view(2, "done", ["ok"]) });
    actions.push({ type: "update", scan: view(3, "done", ["ok"]) });
    actions.push({ type: "update", scan: view(4, "done", ["needs_review"]) });
    actions.push({ type: "update", scan: view(5, "failed") });
    const s = summary(run(actions));
    expect(s).toEqual({ scanned: 6, done: 4, needsReview: 1, failed: 1, unfinished: 1 });
    expect(summaryText(s)).toBe("6 scanned · 4 done · 1 needs review · 1 failed");
  });

  it("omits zero parts", () => {
    expect(summaryText(summary(emptyQueue))).toBe("0 scanned · 0 done");
  });
});

describe("waiting for the server", () => {
  const MIN = 60 * 1000;
  const at = (over: Partial<ScanView>): ScanView => ({ ...view(1, "processing"), ...over });

  it("never times out a scan waiting in line, however long", () => {
    expect(scanTimedOut(at({ status: "queued", startedAt: null, queuePosition: 30, serverTime: 60 * MIN }))).toBe(false);
  });
  it("times out only 6 minutes after the server started reading it", () => {
    expect(GIVE_UP_AFTER_START_MS).toBe(6 * MIN);
    expect(scanTimedOut(at({ startedAt: 10 * MIN, serverTime: 15 * MIN }))).toBe(false);
    expect(scanTimedOut(at({ startedAt: 10 * MIN, serverTime: 16 * MIN + 1 }))).toBe(true);
    expect(scanTimedOut(at({ status: "done", startedAt: 0, serverTime: 60 * MIN }))).toBe(false);
    expect(scanTimedOut(null)).toBe(false);
  });
  it("keeps the latest view while queued and describes the place in line", () => {
    const s = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 1, at: 0 },
      { type: "update", scan: at({ status: "queued", startedAt: null, queuePosition: 3 }) }]);
    expect(s.entries[0]).toMatchObject({ status: "reading", scan: { queuePosition: 3 } });
    expect(waitingText(s.entries[0].scan)).toBe("Waiting in line: 2 scans ahead of this one.");
    expect(waitingText(at({ status: "queued", queuePosition: 2 }))).toBe("Waiting in line: 1 scan ahead of this one.");
    expect(waitingText(at({ status: "queued", queuePosition: 1 }))).toBe("Next in line.");
    expect(waitingText(at({}))).toBeNull();
  });
});

describe("retry", () => {
  const uploaded = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 3, at: 0 }]);

  it("hides Retry for a scan the server accepted, unless the server says it failed", () => {
    const timedOut = run([{ type: "timeout", key: 1 }], uploaded);
    expect(timedOut.entries[0].status).toBe("failed");
    expect(retryKind({ ...timedOut.entries[0], previewUrl: "blob:x" })).toBeNull();
    // Re-uploading is refused for it, so no duplicate can be made.
    expect(run([{ type: "retry", key: 1 }], timedOut)).toBe(timedOut);

    const serverFailed = run([{ type: "update", scan: view(3, "failed") }], uploaded);
    expect(retryKind(serverFailed.entries[0])).toBe("server");
  });
  it("retries a server failure on the same scan instead of uploading again", () => {
    const failed = run([{ type: "update", scan: view(3, "failed") }], uploaded);
    const again = run([{ type: "requeued", key: 1, scan: view(3, "queued") }], failed);
    expect(again.entries[0]).toMatchObject({ status: "reading", scanId: 3, error: null });
    expect(nextToSend(again, 2)).toEqual([]);
    const done = run([{ type: "update", scan: view(3, "done", ["confirmed"]) }], again);
    expect(done.entries[0].status).toBe("done");
    expect(run([{ type: "retryError", key: 1, message: "Gone" }], failed).entries[0].error).toBe("Gone");
  });
  it("uploads again only a photo the server never got", () => {
    const failed = run([add(1), { type: "sending", key: 1 }, { type: "failed", key: 1, message: "No connection" }]);
    expect(retryKind({ ...failed.entries[0], previewUrl: "blob:x" })).toBe("upload");
    expect(retryKind(failed.entries[0])).toBeNull();
  });
});

describe("automatic upload retries", () => {
  const sending = (): QueueState => run([add(1), { type: "sending", key: 1 }]);
  const fail = (s: QueueState) => run([{ type: "uploadFailed", key: 1, message: "Offline" }], s);

  it("waits 2, 8 and 20 seconds, then stops with Not saved", () => {
    expect([...RETRY_DELAYS_MS]).toEqual([2000, 8000, 20000]);
    let s = fail(sending());
    expect(s.entries[0]).toMatchObject({ status: "backoff", attempt: 1 });
    expect(retryDelayMs(s.entries[0])).toBe(2000);
    s = fail(run([{ type: "retryDue", key: 1 }, { type: "sending", key: 1 }], s));
    expect(retryDelayMs(s.entries[0])).toBe(8000);
    s = fail(run([{ type: "retryDue", key: 1 }, { type: "sending", key: 1 }], s));
    expect(retryDelayMs(s.entries[0])).toBe(20000);
    s = fail(run([{ type: "retryDue", key: 1 }, { type: "sending", key: 1 }], s));
    expect(s.entries[0]).toMatchObject({ status: "failed", error: "Offline" });
    expect(entryState(s.entries[0]).text).toBe("Not saved");
    expect(retryKind({ ...s.entries[0], previewUrl: "blob:x" })).toBe("upload");
    // The manual Retry starts the count again.
    expect(run([{ type: "retry", key: 1 }], s).entries[0]).toMatchObject({ status: "waiting", attempt: 0 });
  });

  it("never offers an entry that is sending or waiting to retry, so never two uploads of one entry", () => {
    let s = run([add(1), add(2)]);
    expect(nextToSend(s)).toEqual([1, 2]);
    s = run([{ type: "sending", key: 1 }], s);
    expect(nextToSend(s)).toEqual([2]);
    expect(run([{ type: "sending", key: 1 }], s)).toBe(s);
    s = run([{ type: "uploadFailed", key: 1, message: "x" }], s);
    expect(s.entries[0].status).toBe("backoff");
    expect(nextToSend(s)).toEqual([2]);
    expect(run([{ type: "sending", key: 1 }], s)).toBe(s);
    expect(run([{ type: "retry", key: 1 }], s)).toBe(s);
    expect(run([{ type: "retryDue", key: 1 }], s).entries[0].status).toBe("waiting");
  });

  it("keeps the leave warning on until every entry is saved", () => {
    expect(hasUnsaved(emptyQueue)).toBe(false);
    let s = sending();
    expect(hasUnsaved(s)).toBe(true);
    s = fail(s);
    expect(hasUnsaved(s)).toBe(true);
    const saved = run([{ type: "retryDue", key: 1 }, { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 4, at: 0 }], s);
    expect(hasUnsaved(saved)).toBe(false);
    const notSaved = run([add(2), { type: "sending", key: 2 }, { type: "failed", key: 2, message: "x" }]);
    expect(hasUnsaved(notSaved)).toBe(true);
  });
});

describe("entryState", () => {
  const e = (status: QueueState["entries"][number]["status"], scanId: number | null, scan: ScanView | null) => entryState({ status, scanId, scan, error: null });
  it("uses plain words", () => {
    expect(e("sending", null, null)).toEqual({ kind: "saving", text: "Saving" });
    expect(e("reading", 1, view(1, "processing")).text).toBe("Saved, being read");
    expect(e("reading", 1, view(1, "queued")).text).toBe("Saved, waiting to be read");
    expect(e("done", 1, view(1, "done", ["confirmed"]))).toEqual({ kind: "read", text: "Read" });
    expect(e("done", 1, view(1, "done", ["confirmed", "needs_review"])).text).toBe("Check this one");
    expect(e("done", 1, view(1, "done")).text).toBe("No card found");
    expect(e("failed", 1, view(1, "failed")).text).toBe("Did not work");
    expect(e("failed", 1, view(1, "processing")).kind).toBe("slow");
  });
});

describe("sending with a fake fetch", () => {
  const job = (key: string): ScanJob => ({
    mode: "single", clientKey: key, hint: " 1989 ", locationId: "", front: new File(["x"], "f.jpg", { type: "image/jpeg" }), source: [],
  });

  /** Acts like the server: one scan per clientKey, 201 first time, 200 for a repeat. */
  function fakeServer(failFirst: number) {
    const scans = new Map<string, number>();
    let calls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls += 1;
      if (calls <= failFirst) throw new TypeError("offline");
      const key = (init.body as FormData).get("clientKey") as string;
      const had = scans.has(key);
      if (!had) scans.set(key, scans.size + 1);
      return Response.json({ scanId: scans.get(key) }, { status: had ? 200 : 201 });
    }) as unknown as typeof fetch;
    return { fetchFn, scans, calls: () => calls };
  }

  it("builds the form with the clientKey and trimmed hint", () => {
    const body = buildScanBody(job("abc"));
    expect(body.get("clientKey")).toBe("abc");
    expect(body.get("hint")).toBe("1989");
    expect(body.get("front")).toBeInstanceOf(File);
  });

  it("answers saved only for 200 or 201 with a scan id", async () => {
    const reply = (status: number, json: object) => (async () => Response.json(json, { status })) as unknown as typeof fetch;
    expect(await postScan(reply(201, { scanId: 5 }), job("a"))).toEqual({ ok: true, scanId: 5 });
    expect(await postScan(reply(200, { scanId: 5 }), job("a"))).toEqual({ ok: true, scanId: 5 });
    expect(await postScan(reply(400, { error: "Bad" }), job("a"))).toEqual({ ok: false, message: "Bad", failure: "final" });
    expect(await postScan(reply(500, {}), job("a"))).toMatchObject({ ok: false });
    expect(await postScan(reply(201, {}), job("a"))).toMatchObject({ ok: false });
  });

  it("fails twice, then works: one scan, retried after 2 s and 8 s", async () => {
    const server = fakeServer(2);
    let state: QueueState = emptyQueue;
    const timers: { fn: () => void; ms: number }[] = [];
    const saved: number[] = [];
    const dispatch = (a: QueueAction) => { state = queueReducer(state, a); };
    const up = createUploader({
      getState: () => state,
      dispatch,
      send: (key) => postScan(server.fetchFn, job(state.entries.find((x) => x.key === key)!.clientKey)),
      later: (fn, ms) => timers.push({ fn, ms }),
      now: () => 0,
      onSaved: (k) => saved.push(k),
    });
    dispatch(add(1));
    up.pump();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(state.entries[0].status).toBe("backoff");
    expect(timers[0].ms).toBe(2000);
    timers[0].fn();
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(timers[1].ms).toBe(8000);
    expect(saved).toEqual([]);
    timers[1].fn();
    await vi.waitFor(() => expect(state.entries[0].status).toBe("reading"));
    expect(server.calls()).toBe(3);
    expect(server.scans.size).toBe(1);
    expect(state.entries[0].scanId).toBe(1);
    expect(saved).toEqual([1]);
  });

  it("a repeat after a lost answer gives the same scan, not a second one", async () => {
    const server = fakeServer(0);
    const a = await postScan(server.fetchFn, job("same"));
    const b = await postScan(server.fetchFn, job("same"));
    expect(a).toEqual(b);
    expect(server.scans.size).toBe(1);
  });

  it("never runs more than 2 uploads at once and keeps the failed one after 3 retries", async () => {
    let active = 0, peak = 0, sends = 0;
    const resolvers: ((r: SendResult) => void)[] = [];
    let state: QueueState = emptyQueue;
    const dispatch = (a: QueueAction) => { state = queueReducer(state, a); };
    const timers: (() => void)[] = [];
    const up = createUploader({
      getState: () => state, dispatch,
      send: () => new Promise<SendResult>((res) => {
        sends += 1; active += 1; peak = Math.max(peak, active);
        resolvers.push((r) => { active -= 1; res(r); });
      }),
      later: (fn) => timers.push(fn), now: () => 0, onSaved: () => {},
    });
    [1, 2, 3].forEach((k) => dispatch(add(k)));
    up.pump();
    expect(resolvers).toHaveLength(2);
    up.pump();
    expect(resolvers).toHaveLength(2);
    // Every try fails: answer each, fire each retry timer, until nothing is left to do.
    for (let guard = 0; guard < 100 && (resolvers.length > 0 || timers.length > 0); guard++) {
      if (resolvers.length > 0) resolvers.shift()!({ ok: false, message: "Offline", failure: "retryable" });
      else timers.shift()!();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    expect(resolvers).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(peak).toBeLessThanOrEqual(2);
    // 1 first try plus 3 automatic retries for each of the 3 entries.
    expect(sends).toBe(12);
    const first = state.entries.find((e) => e.key === 1)!;
    expect(first.status).toBe("failed");
    expect(first.attempt).toBe(3);
    expect(first.error).toBe("Offline");
    expect(state.entries.every((e) => e.status === "failed" && e.attempt === 3)).toBe(true);
    expect(retryKind({ ...first, previewUrl: "blob:x" })).toBe("upload");
  });
});

describe("errors the server gives", () => {
  const sending = (): QueueState => run([add(1), { type: "sending", key: 1 }]);
  const failWith = (failure: UploadFailure) =>
    run([{ type: "uploadFailed", key: 1, message: "Server said no", failure }], sending()).entries[0];

  it("sorts answers by status: 4xx stop at once, except 408 and 429", () => {
    expect(failureFor(400)).toBe("final");
    expect(failureFor(413)).toBe("final");
    expect(failureFor(415)).toBe("final");
    expect(failureFor(401)).toBe("signIn");
    expect(failureFor(403)).toBe("rejected");
    expect(failureFor(404)).toBe("rejected");
    expect(failureFor(422)).toBe("rejected");
    expect(failureFor(408)).toBe("retryable");
    expect(failureFor(429)).toBe("retryable");
    expect(failureFor(500)).toBe("retryable");
    expect(failureFor(503)).toBe("retryable");
  });

  it("400, 413 and 415 go straight to Not saved with the server's message and no Retry", () => {
    const e = failWith("final");
    expect(e).toMatchObject({ status: "failed", attempt: 0, error: "Server said no", failure: "final" });
    expect(entryState(e).text).toBe("Not saved");
    expect(retryKind({ ...e, previewUrl: "blob:x" })).toBeNull();
    expect(canRelease(e)).toBe(true);
  });

  it("401 stops at once but keeps Retry and the photo", () => {
    const e = failWith("signIn");
    expect(e).toMatchObject({ status: "failed", attempt: 0, failure: "signIn" });
    expect(retryKind({ ...e, previewUrl: "blob:x" })).toBe("upload");
    expect(canRelease(e)).toBe(false);
    const again = run([{ type: "retry", key: 1 }], run([{ type: "uploadFailed", key: 1, message: "x", failure: "signIn" }], sending()));
    expect(again.entries[0]).toMatchObject({ status: "waiting", failure: null, error: null });
  });

  it("other 4xx stop at once and keep Retry", () => {
    const e = failWith("rejected");
    expect(e).toMatchObject({ status: "failed", attempt: 0 });
    expect(retryKind({ ...e, previewUrl: "blob:x" })).toBe("upload");
  });

  it("a retryable answer waits and tries again", () => {
    expect(failWith("retryable")).toMatchObject({ status: "backoff", attempt: 1 });
  });

  it("postScan passes the server's short message and the kind of failure", async () => {
    const reply = (status: number, json: object) => (async () => Response.json(json, { status })) as unknown as typeof fetch;
    const job: ScanJob = { mode: "single", clientKey: "k", hint: "", locationId: "", source: [] };
    expect(await postScan(reply(413, { error: "Too large" }), job)).toEqual({ ok: false, message: "Too large", failure: "final" });
    expect(await postScan(reply(415, {}), job)).toMatchObject({ ok: false, failure: "final" });
    expect(await postScan(reply(401, { error: "Please sign in." }), job)).toEqual({ ok: false, message: "Please sign in.", failure: "signIn" });
    expect(await postScan(reply(404, { error: "Gone" }), job)).toEqual({ ok: false, message: "Gone", failure: "rejected" });
    expect(await postScan(reply(429, {}), job)).toMatchObject({ ok: false, failure: "retryable" });
    expect(await postScan(reply(408, {}), job)).toMatchObject({ ok: false, failure: "retryable" });
    expect(await postScan(reply(502, {}), job)).toMatchObject({ ok: false, failure: "retryable" });
    // A long body is never shown as the message.
    expect(await postScan(reply(403, { error: "x".repeat(500) }), job)).toEqual({ ok: false, message: "The server did not accept these photos.", failure: "rejected" });
  });
});

describe("upload time limit", () => {
  /** A fetch that never answers until its signal stops it, like a stalled connection. */
  const stalled = (async (_url: string, init: RequestInit) =>
    new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
  const job: ScanJob = { mode: "single", clientKey: "k", hint: "", locationId: "", source: [] };

  it("is 90 seconds and a timeout is a failure that is tried again", async () => {
    expect(UPLOAD_TIMEOUT_MS).toBe(90_000);
    const r = await postScan(stalled, job, 20);
    expect(r).toEqual({ ok: false, message: UPLOAD_TIMEOUT_MESSAGE, failure: "retryable" });
  });

  it("sends the time limit signal with every try", async () => {
    let signal: AbortSignal | undefined;
    const spy = (async (_u: string, init: RequestInit) => { signal = init.signal ?? undefined; return Response.json({ scanId: 1 }, { status: 201 }); }) as unknown as typeof fetch;
    await postScan(spy, job);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("a stalled upload does not block the queue forever", async () => {
    let state: QueueState = emptyQueue;
    const dispatch = (a: QueueAction) => { state = queueReducer(state, a); };
    const timers: (() => void)[] = [];
    let calls = 0;
    const up = createUploader({
      getState: () => state, dispatch,
      // Entries 1 and 2 stall; entry 3 would work at once.
      send: (key) => { calls += 1; return postScan(key === 3 ? (async () => Response.json({ scanId: 9 }, { status: 201 })) as unknown as typeof fetch : stalled, job, 20); },
      later: (fn) => timers.push(fn), now: () => 0, onSaved: () => {},
    });
    [1, 2, 3].forEach((k) => dispatch(add(k)));
    up.pump();
    expect(state.entries.map((e) => e.status)).toEqual(["sending", "sending", "waiting"]);
    await vi.waitFor(() => expect(state.entries[2].status).toBe("reading"));
    expect(state.entries[0]).toMatchObject({ status: "backoff", attempt: 1, error: UPLOAD_TIMEOUT_MESSAGE });
    expect(timers.length).toBeGreaterThan(0);
    expect(calls).toBe(3);
  });
});

describe("liveText and canRelease", () => {
  it("announces counts and the keep open notice", () => {
    expect(liveText(emptyQueue)).toBe("");
    const s = run([add(1), add(2), add(3), { type: "sending", key: 3 }, { type: "uploadFailed", key: 3, message: "x", failure: "final" }]);
    expect(liveText(s)).toBe(`2 saving, 1 not saved. ${KEEP_OPEN_MESSAGE}`);
    const saved = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 1, at: 0 }]);
    expect(liveText(saved)).toBe("1 saved, being read.");
  });

  it("lets go of photos once read, failed on the server, timed out or refused for good; keeps them while Retry can send them", () => {
    const up = run([add(1), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 3, at: 0 }]);
    expect(canRelease(up.entries[0])).toBe(false);
    expect(canRelease(run([{ type: "update", scan: view(3, "done", ["ok"]) }], up).entries[0])).toBe(true);
    expect(canRelease(run([{ type: "update", scan: view(3, "failed") }], up).entries[0])).toBe(true);
    expect(canRelease(run([{ type: "timeout", key: 1 }], up).entries[0])).toBe(true);
    const notSaved = run([add(2), { type: "sending", key: 2 }, { type: "uploadFailed", key: 2, message: "x", failure: "rejected" }]);
    expect(canRelease(notSaved.entries[0])).toBe(false);
    expect(run([{ type: "released", key: 1 }], run([add(1)])).entries[0].previewUrl).toBeNull();
  });
});

describe("sign out with photos not saved", () => {
  it("goes ahead without asking when everything is saved", () => {
    const ask = vi.fn(() => false);
    expect(maySignOut(false, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it("asks first when photos are not saved; Cancel keeps the owner on the page", () => {
    const ask = vi.fn(() => false);
    expect(maySignOut(true, ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith("Some photos are not saved yet. Sign out anyway and lose them?");
    expect(SIGN_OUT_QUESTION).toBe("Some photos are not saved yet. Sign out anyway and lose them?");
    expect(maySignOut(true, () => true)).toBe(true);
  });
});

describe("signed out and long waits", () => {
  it("marks only entries being read as signed out, and clears it again", () => {
    let s = run([add(1), add(2), { type: "sending", key: 1 }, { type: "uploaded", key: 1, scanId: 9, at: 0 }]);
    s = queueReducer(s, { type: "signedOut", value: true });
    expect(s.entries.map((e) => e.signedOut)).toEqual([true, false]);
    s = queueReducer(s, { type: "signedOut", value: false });
    expect(s.entries.map((e) => e.signedOut)).toEqual([false, false]);
    expect(queueReducer(s, { type: "signedOut", value: false })).toBe(s);
  });
  it("a scan waiting in line is given up on 6 minutes after it was saved, by the page clock", () => {
    const e = { status: "reading" as const, scan: view(1, "queued"), uploadedAt: 1000 };
    expect(queuedTooLong(e, 1000 + GIVE_UP_AFTER_START_MS)).toBe(false);
    expect(queuedTooLong(e, 1001 + GIVE_UP_AFTER_START_MS)).toBe(true);
    expect(queuedTooLong({ ...e, scan: view(1, "processing") }, 1e9)).toBe(false);
  });
});
