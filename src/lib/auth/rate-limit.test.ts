import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { clientIp, isRateLimited, recordAttempt, WINDOW_MS } from "./rate-limit";

const T0 = new Date("2026-01-01T12:00:00Z");

describe("rate limit", () => {
  it("blocks one IP after 5 failures, not others", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 4; i++) recordAttempt("1.1.1.1", false, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
    recordAttempt("1.1.1.1", false, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(true);
    expect(isRateLimited("2.2.2.2", db, T0)).toBe(false);
  });
  it("blocks everyone after 30 failures overall", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 30; i++) recordAttempt(`10.0.0.${i}`, false, db, T0);
    expect(isRateLimited("9.9.9.9", db, T0)).toBe(true);
  });
  it("does not count successes, and success does not clear failures", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 5; i++) recordAttempt("1.1.1.1", true, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
    for (let i = 0; i < 5; i++) recordAttempt("1.1.1.1", false, db, T0);
    recordAttempt("1.1.1.1", true, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(true);
  });
  it("expires after the window", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 5; i++) recordAttempt("1.1.1.1", false, db, T0);
    expect(isRateLimited("1.1.1.1", db, new Date(T0.getTime() + WINDOW_MS - 1000))).toBe(true);
    expect(isRateLimited("1.1.1.1", db, new Date(T0.getTime() + WINDOW_MS + 1000))).toBe(false);
  });
  it("reads the first forwarded IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("beginAttempt", () => {
  it("books a failure up front and refuses once the limit is reached", async () => {
    const { beginAttempt, markAttemptSucceeded } = await import("./rate-limit");
    const db = createDb(":memory:");
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(beginAttempt("1.1.1.1", db, T0));
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    // Five guesses are booked before any password check finished: the sixth is refused.
    expect(beginAttempt("1.1.1.1", db, T0)).toBeNull();
    // A success frees one slot only for that attempt.
    markAttemptSucceeded(ids[0]!, db);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
  });
});
