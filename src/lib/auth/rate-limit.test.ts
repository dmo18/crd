import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { loginAttempts } from "@/db/schema";
import {
  beginAttempt, clientIp, currentLock, isRateLimited, markAttemptSucceeded, MAX_FAILS_GLOBAL,
  pruneLoginAttempts, PRUNE_EVERY, recordAttempt, resetPruneCounter,
} from "./rate-limit";

const T0 = new Date("2026-01-01T12:00:00Z");
const MIN = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function fail(db: Db, ip: string, n: number, when: Date = T0) {
  for (let i = 0; i < n; i++) recordAttempt(ip, false, db, when);
}

describe("clientIp", () => {
  const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });

  it("with 0 hops never trusts the header", () => {
    expect(clientIp(h("3.3.3.3"), 0)).toBe("unknown");
    expect(clientIp(h(), 0)).toBe("unknown");
  });
  it("takes the Nth entry from the right", () => {
    expect(clientIp(h("1.1.1.1, 2.2.2.2, 3.3.3.3"), 1)).toBe("3.3.3.3");
    expect(clientIp(h("1.1.1.1, 2.2.2.2, 3.3.3.3"), 2)).toBe("2.2.2.2");
    expect(clientIp(h("1.1.1.1,2.2.2.2,3.3.3.3"), 3)).toBe("1.1.1.1");
  });
  it("ignores spoofed entries on the left", () => {
    // A visitor sends their own X-Forwarded-For; the trusted proxy appends the real address.
    expect(clientIp(h("6.6.6.6, 7.7.7.7, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(h("evil, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });
  it("returns unknown when there are fewer entries than hops", () => {
    expect(clientIp(h("203.0.113.9"), 2)).toBe("unknown");
    expect(clientIp(h(), 1)).toBe("unknown");
  });
  it("accepts IPv6 and rejects things that are not addresses", () => {
    expect(clientIp(h("2001:DB8::1"), 1)).toBe("2001:db8:0:0::/64");
    expect(clientIp(h("not-an-ip"), 1)).toBe("unknown");
    expect(clientIp(h("1.1.1.1:443"), 1)).toBe("unknown");
    expect(clientIp(h("999.1.1.1"), 1)).toBe("unknown");
    expect(clientIp(h("1.1.1.1, "), 1)).toBe("unknown");
    expect(clientIp(h("<script>"), 1)).toBe("unknown");
  });
  it("refuses hop counts outside 1 to 5", () => {
    expect(clientIp(h("1.1.1.1,1.1.1.1,1.1.1.1,1.1.1.1,1.1.1.1,1.1.1.1"), 6)).toBe("unknown");
    expect(clientIp(h("1.1.1.1"), -1)).toBe("unknown");
    expect(clientIp(h("1.1.1.1"), 1.5)).toBe("unknown");
  });
});

describe("clientIp with a named header (CLIENT_IP_HEADER)", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("uses only that header and ignores X-Forwarded-For and hops", () => {
    const headers = h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 10.0.0.2" });
    expect(clientIp(headers, 0, "cf-connecting-ip")).toBe("203.0.113.9");
    expect(clientIp(headers, 2, "cf-connecting-ip")).toBe("203.0.113.9");
    expect(clientIp(headers, 1, "CF-Connecting-IP")).toBe("203.0.113.9");
  });
  it("is unknown when the header is missing, even if X-Forwarded-For is present", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6" }), 1, "cf-connecting-ip")).toBe("unknown");
  });
  it("takes the first entry, trimmed, and validates it", () => {
    expect(clientIp(h({ "x-real-ip": " 198.51.100.7 , 1.1.1.1" }), 0, "x-real-ip")).toBe("198.51.100.7");
    expect(clientIp(h({ "x-real-ip": "nope" }), 0, "x-real-ip")).toBe("unknown");
    expect(clientIp(h({ "x-real-ip": "1.1.1.1:443" }), 0, "x-real-ip")).toBe("unknown");
    expect(clientIp(h({ "x-real-ip": "" }), 0, "x-real-ip")).toBe("unknown");
  });
  it("refuses a header name that is not a plain name", () => {
    expect(clientIp(h({ "x-a": "1.1.1.1" }), 0, "x a")).toBe("unknown");
  });
});

describe("clientIp groups IPv6 visitors by /64 network", () => {
  const h = (v: string) => new Headers({ "x-forwarded-for": v });
  const want = "2001:db8:1:2::/64";

  it("gives the same key for compressed and expanded forms, and any address in the /64", () => {
    expect(clientIp(h("2001:db8:1:2::1"), 1)).toBe(want);
    expect(clientIp(h("2001:0db8:0001:0002:0000:0000:0000:0001"), 1)).toBe(want);
    expect(clientIp(h("2001:DB8:1:2:aaaa:bbbb:cccc:dddd"), 1)).toBe(want);
    expect(clientIp(h("2001:db8:1:2::"), 1)).toBe(want);
  });
  it("keeps different /64 networks apart", () => {
    expect(clientIp(h("2001:db8:1:3::1"), 1)).not.toBe(want);
  });
  it("handles :: at the start and a short head", () => {
    expect(clientIp(h("::1"), 1)).toBe("0:0:0:0::/64");
    expect(clientIp(h("2001:db8::5"), 1)).toBe("2001:db8:0:0::/64");
  });
  it("treats IPv4-mapped addresses as the IPv4 address", () => {
    expect(clientIp(h("::ffff:203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(h("::FFFF:cb00:7109"), 1)).toBe("203.0.113.9");
    expect(clientIp(h("0:0:0:0:0:ffff:203.0.113.9"), 1)).toBe("203.0.113.9");
  });
  it("leaves IPv4 unchanged and works through a named header too", () => {
    expect(clientIp(h("203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "cf-connecting-ip": "2001:db8:1:2::9" }), 0, "cf-connecting-ip")).toBe(want);
  });
  it("rejects zone ids and malformed addresses", () => {
    expect(clientIp(h("fe80::1%eth0"), 1)).toBe("unknown");
    expect(clientIp(h("2001:db8:::1"), 1)).toBe("unknown");
  });
});

describe("short lock", () => {
  it("locks one address after 5 failures in 15 minutes, not others", () => {
    const db = createDb(":memory:");
    fail(db, "1.1.1.1", 4);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
    fail(db, "1.1.1.1", 1);
    expect(currentLock("1.1.1.1", db, T0)).toBe("short");
    expect(isRateLimited("2.2.2.2", db, T0)).toBe(false);
  });
  it("lasts 15 minutes from the failure that caused it", () => {
    const db = createDb(":memory:");
    fail(db, "1.1.1.1", 4, T0);
    fail(db, "1.1.1.1", 1, at(14 * MIN));
    // A plain rolling window would have opened at 15 minutes.
    expect(isRateLimited("1.1.1.1", db, at(28 * MIN))).toBe(true);
    expect(isRateLimited("1.1.1.1", db, at(29 * MIN + 1000))).toBe(false);
  });
  it("does not lock when the 5 failures are spread over more than 15 minutes", () => {
    const db = createDb(":memory:");
    fail(db, "1.1.1.1", 4, T0);
    fail(db, "1.1.1.1", 1, at(16 * MIN));
    expect(isRateLimited("1.1.1.1", db, at(16 * MIN))).toBe(false);
  });
  it("does not count successes, and a success does not clear failures", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 5; i++) recordAttempt("1.1.1.1", true, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
    fail(db, "1.1.1.1", 5);
    recordAttempt("1.1.1.1", true, db, T0);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(true);
  });
});

describe("long lock", () => {
  it("10 failures in 24 hours lock that address for 24 hours", () => {
    const db = createDb(":memory:");
    resetPruneCounter();
    // First round: 5 failures, then the short lock refuses more.
    for (let i = 0; i < 5; i++) expect(beginAttempt("1.1.1.1", db, T0).ok).toBe(true);
    expect(beginAttempt("1.1.1.1", db, at(MIN))).toEqual({ ok: false, lock: "short" });
    // After the short lock, 5 more failures.
    const later = at(20 * MIN);
    for (let i = 0; i < 5; i++) expect(beginAttempt("1.1.1.1", db, later).ok).toBe(true);
    expect(beginAttempt("1.1.1.1", db, at(40 * MIN))).toEqual({ ok: false, lock: "long" });
    expect(currentLock("1.1.1.1", db, at(20 * MIN + 23 * 60 * MIN))).toBe("long");
    expect(currentLock("1.1.1.1", db, at(20 * MIN + 24 * 60 * MIN + 1000))).toBeNull();
    expect(currentLock("2.2.2.2", db, at(40 * MIN))).toBeNull();
  });
  it("does not apply when the 10 failures are spread over more than 24 hours", () => {
    const db = createDb(":memory:");
    fail(db, "1.1.1.1", 5, T0);
    fail(db, "1.1.1.1", 5, at(25 * 60 * MIN));
    expect(currentLock("1.1.1.1", db, at(25 * 60 * MIN))).toBe("short");
    expect(currentLock("1.1.1.1", db, at(25 * 60 * MIN + 16 * MIN))).toBeNull();
  });
});

describe("global pause", () => {
  it("pauses everyone after 300 failures across all addresses in 15 minutes", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < MAX_FAILS_GLOBAL - 1; i++) recordAttempt(`10.0.${Math.floor(i / 4)}.${i % 4}`, false, db, T0);
    expect(currentLock("9.9.9.9", db, T0)).toBeNull();
    recordAttempt("10.9.9.9", false, db, T0);
    expect(currentLock("9.9.9.9", db, T0)).toBe("global");
    expect(currentLock("9.9.9.9", db, at(15 * MIN + 1000))).toBeNull();
  });
  it("30 strangers no longer lock the owner out", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 30; i++) recordAttempt(`10.0.0.${i}`, false, db, T0);
    expect(isRateLimited("9.9.9.9", db, T0)).toBe(false);
  });
});

describe("beginAttempt", () => {
  beforeEach(() => resetPruneCounter());

  it("books a failure up front and refuses once the limit is reached", () => {
    const db = createDb(":memory:");
    const results = [];
    for (let i = 0; i < 5; i++) results.push(beginAttempt("1.1.1.1", db, T0));
    expect(results.every((r) => r.ok)).toBe(true);
    // Five guesses are booked before any password check finished: the sixth is refused.
    expect(beginAttempt("1.1.1.1", db, T0)).toEqual({ ok: false, lock: "short" });
    // A success frees one slot only for that attempt.
    const first = results[0]!;
    if (first.ok) markAttemptSucceeded(first.id, db);
    expect(isRateLimited("1.1.1.1", db, T0)).toBe(false);
  });

  it("refused attempts are not booked", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 8; i++) beginAttempt("1.1.1.1", db, T0);
    expect(db.select().from(loginAttempts).all()).toHaveLength(5);
  });

  it("deletes records older than 30 days now and then", () => {
    const db = createDb(":memory:");
    const old = new Date(T0.getTime() - 31 * 24 * 60 * MIN);
    fail(db, "5.5.5.5", 3, old);
    recordAttempt("5.5.5.5", true, db, new Date(T0.getTime() - 29 * 24 * 60 * MIN));
    // The first call after a reset prunes.
    beginAttempt("1.1.1.1", db, T0);
    const left = db.select().from(loginAttempts).all();
    expect(left).toHaveLength(2);
    // Then not again until PRUNE_EVERY more calls.
    fail(db, "5.5.5.5", 1, old);
    for (let i = 1; i < PRUNE_EVERY; i++) beginAttempt(`7.7.${Math.floor(i / 250)}.${i % 250}`, db, at(i));
    expect(db.select().from(loginAttempts).all().filter((r) => r.createdAt < T0)).toHaveLength(2);
    beginAttempt("8.8.8.8", db, at(PRUNE_EVERY));
    expect(db.select().from(loginAttempts).all().filter((r) => r.createdAt < T0)).toHaveLength(1);
  });

  it("pruneLoginAttempts keeps recent rows", () => {
    const db = createDb(":memory:");
    fail(db, "1.1.1.1", 2, new Date(T0.getTime() - 30 * 24 * 60 * MIN - 1000));
    fail(db, "1.1.1.1", 2, new Date(T0.getTime() - 30 * 24 * 60 * MIN + 1000));
    expect(pruneLoginAttempts(db, T0)).toBe(2);
    expect(db.select().from(loginAttempts).all()).toHaveLength(2);
  });

  it("setup, password change and sign-in share the same limits", () => {
    const db = createDb(":memory:");
    expect(beginAttempt("1.1.1.1", db, T0, "setup").ok).toBe(true);
    expect(beginAttempt("1.1.1.1", db, T0, "change_password").ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(beginAttempt("1.1.1.1", db, T0).ok).toBe(true);
    expect(beginAttempt("1.1.1.1", db, T0, "setup")).toEqual({ ok: false, lock: "short" });
    expect(beginAttempt("1.1.1.1", db, T0)).toEqual({ ok: false, lock: "short" });
    const kinds = db.select({ kind: loginAttempts.kind }).from(loginAttempts).all().map((r) => r.kind);
    expect(kinds).toEqual(["setup", "change_password", "login", "login", "login"]);
  });
});
