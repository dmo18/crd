import { describe, expect, it } from "vitest";
import { nextStatusAskMs, parseCounts, pillText, STATUS_POLL_MS } from "./scan-status-poll";

describe("when the pill asks again", () => {
  it("asks every 5 seconds only while scans are being read and the tab is visible", () => {
    expect(nextStatusAskMs(3, false)).toBe(STATUS_POLL_MS);
    expect(STATUS_POLL_MS).toBe(5000);
  });
  it("stops at 0 being read", () => expect(nextStatusAskMs(0, false)).toBeNull());
  it("never asks while the tab is hidden", () => expect(nextStatusAskMs(5, true)).toBeNull());
});

describe("pill words", () => {
  it("is hidden when nothing is being read and nothing failed", () => {
    expect(pillText(null)).toBeNull();
    expect(pillText({ reading: 0, failed: 0, toReview: 4 })).toBeNull();
  });
  it("says what is happening", () => {
    expect(pillText({ reading: 3, failed: 0, toReview: 0 })).toEqual({ reading: "3 being read", failed: null });
    expect(pillText({ reading: 0, failed: 1, toReview: 0 })).toEqual({ reading: null, failed: "1 did not work" });
    expect(pillText({ reading: 2, failed: 1, toReview: 0 })).toEqual({ reading: "2 being read", failed: "1 did not work" });
  });
});

describe("parseCounts", () => {
  it("accepts the route answer and rejects anything else", () => {
    expect(parseCounts({ reading: 1, failed: 2, toReview: 3 })).toEqual({ reading: 1, failed: 2, toReview: 3 });
    expect(parseCounts({ reading: -1, failed: 0, toReview: 0 })).toBeNull();
    expect(parseCounts({ reading: "1" })).toBeNull();
    expect(parseCounts(null)).toBeNull();
  });
});
