import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { outsideCache } from "@/db/schema";
import { CACHE_KEEP_MS, cacheKey, clearCache, getCached, pruneCache, putCached } from "./cache";
import { bumpUsage, usageDays } from "./usage";

const T = Date.parse("2026-11-16T12:00:00Z");
const DAY = 86_400_000;

describe("stored answers", () => {
  it("keeps each kind for its own time", () => {
    expect(CACHE_KEEP_MS).toEqual({ search: 7 * DAY, search_empty: DAY, card: 30 * DAY, checklist: 30 * DAY });
  });

  it("one key per source, tool and arguments, whatever the order, case and spacing", () => {
    const a = cacheKey("mycardfolio", "search_cards", { query: "1990 Topps  Griffey", limit: 5 });
    expect(cacheKey("mycardfolio", "search_cards", { limit: 5, query: " 1990 topps griffey" })).toBe(a);
    expect(cacheKey("mycardfolio", "search_cards", { query: "1990 Topps Griffey", limit: 1 })).not.toBe(a);
    expect(cacheKey("mycardfolio", "get_card", { query: "1990 Topps Griffey", limit: 5 })).not.toBe(a);
    expect(cacheKey("wikidata", "search_cards", { query: "1990 Topps Griffey", limit: 5 })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves until expiry, prunes expired rows, and clears one source", () => {
    const db = createDb(":memory:");
    putCached(db, { key: "k1", source: "mycardfolio", kind: "search", body: "a", nowMs: T });
    putCached(db, { key: "k2", source: "mycardfolio", kind: "search_empty", body: "b", nowMs: T });
    putCached(db, { key: "k3", source: "wikidata", kind: "card", body: "c", nowMs: T });
    expect(getCached(db, "k2", T + DAY - 1)?.body).toBe("b");
    expect(getCached(db, "k2", T + DAY)).toBeNull();
    expect(pruneCache(db, T + 2 * DAY)).toBe(1);
    expect(clearCache(db, "mycardfolio")).toBe(1);
    expect(db.select().from(outsideCache).all().map((r) => r.key)).toEqual(["k3"]);
  });
});

describe("usage counters", () => {
  it("adds up per source and UTC day and lists 7 days with zeros", () => {
    const db = createDb(":memory:");
    bumpUsage(db, "mycardfolio", T, { calls: 1, waitMs: 2000 });
    bumpUsage(db, "mycardfolio", T, { calls: 1, storeHits: 2 });
    bumpUsage(db, "mycardfolio", T - DAY, { errors: 1 });
    bumpUsage(db, "wikidata", T, { calls: 5 });
    const days = usageDays(db, "mycardfolio", T);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ day: "2026-11-16", calls: 2, storeHits: 2, errors: 0, slowDowns: 0, skipped: 0, waitMs: 2000 });
    expect(days[1]).toMatchObject({ day: "2026-11-15", errors: 1, calls: 0 });
    expect(days[6]).toMatchObject({ day: "2026-11-10", calls: 0 });
  });
});
