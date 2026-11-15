import { describe, expect, it } from "vitest";
import type { ScanView } from "@/lib/scans/view";
import {
  atCap, emptyQueue, GIVE_UP_AFTER_START_MS, MAX_QUEUE, nextToSend, queueReducer, retryKind, scanTimedOut, summary, summaryText,
  TIMEOUT_MESSAGE, waitingText, type QueueAction, type QueueState,
} from "./scan-queue";

function run(actions: QueueAction[], from: QueueState = emptyQueue): QueueState {
  return actions.reduce(queueReducer, from);
}
const add = (key: number): QueueAction => ({ type: "add", key, name: `p${key}.jpg`, previewUrl: null });
function view(id: number, status: ScanView["status"], itemStatuses: string[] = []): ScanView {
  return {
    id, mode: "single", status, error: status === "failed" ? "Bad photo" : null, itemCount: itemStatuses.length, createdAt: 0,
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
