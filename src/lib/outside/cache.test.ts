import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { outsideCache } from "@/db/schema";
import { CACHE_KEEP_MS, cacheTotalBytes, clearCache, getCached, pruneCache, putCached, requestKey } from "./cache";
import { bumpUsage, usageDays } from "./usage";

const T = Date.parse("2026-11-16T12:00:00Z");
const DAY = 86_400_000;

describe("stored answers", () => {
  it("keeps each kind for its own time", () => {
    expect(CACHE_KEEP_MS).toEqual({ search: 7 * DAY, search_empty: DAY, card: 30 * DAY, checklist: 30 * DAY });
  });

  it("the key is the real request: method, host, path, sorted query and the JSON body as sent", () => {
    const mcp = (args: Record<string, unknown>, id = 1) => ({
      method: "POST", host: "mycardfolio.com", path: "/api/mcp",
      json: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_cards", arguments: args } },
    });
    const free = ["query"];
    const a = requestKey(mcp({ query: "1990 Topps Griffey", limit: 5 }), free);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Only the named free-text field is lowercased and trimmed.
    expect(requestKey(mcp({ query: "  1990 TOPPS griffey " , limit: 5 }), free)).toBe(a);
    // Everything else counts exactly as sent.
    expect(requestKey(mcp({ query: "1990 Topps Griffey", limit: 1 }), free)).not.toBe(a);
    expect(requestKey(mcp({ query: "1990 Topps Griffey", limit: "5" }), free)).not.toBe(a);
    expect(requestKey(mcp({ query: "1990 Topps Griffey", limit: 5, year: "1990" }), free)).not.toBe(a);
    expect(requestKey(mcp({ query: "1990 Topps Griffey", limit: 5 }, 2), free)).not.toBe(a);
    expect(requestKey({ ...mcp({ query: "1990 Topps Griffey", limit: 5 }), path: "/api/other" }, free)).not.toBe(a);
    expect(requestKey({ ...mcp({ query: "1990 Topps Griffey", limit: 5 }), host: "www.wikidata.org" }, free)).not.toBe(a);
    expect(requestKey({ ...mcp({ query: "1990 Topps Griffey", limit: 5 }), method: "PUT" }, free)).not.toBe(a);
    // Without naming it, a free-text field is not folded either.
    expect(requestKey(mcp({ query: "1990 TOPPS griffey", limit: 5 }))).not.toBe(requestKey(mcp({ query: "1990 Topps Griffey", limit: 5 })));
    // A field with another name keeps its case, even holding the same words.
    expect(requestKey(mcp({ query: "x", set_name: "Topps" }), free)).not.toBe(requestKey(mcp({ query: "x", set_name: "topps" }), free));
  });

  it("the query is sorted by name, and only named query fields are folded", () => {
    const get = (query: Record<string, string>) => ({ method: "GET", host: "www.wikidata.org", path: "/w/api.php", query });
    const k = requestKey(get({ action: "wbsearchentities", search: "Ken Griffey", limit: "1" }), ["search"]);
    expect(requestKey(get({ limit: "1", search: " ken griffey", action: "wbsearchentities" }), ["search"])).toBe(k);
    expect(requestKey(get({ limit: "1", search: "Ken Griffey", action: "WBSEARCHENTITIES" }), ["search"])).not.toBe(k);
    expect(requestKey(get({ action: "wbsearchentities", search: "Ken Griffey", limit: "2" }), ["search"])).not.toBe(k);
    // A body changes the key; no body and an empty query are not the same as a body.
    expect(requestKey({ ...get({}), method: "POST", json: {} })).not.toBe(requestKey({ ...get({}), method: "POST" }));
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

describe("pruning", () => {
  it("removes the oldest past the cap and counts the total", () => {
    const db = createDb(":memory:");
    for (const [i, k] of ["a", "b", "c"].entries()) putCached(db, { key: k, source: "mycardfolio", kind: "card", body: "x".repeat(400), nowMs: T + i });
    expect(cacheTotalBytes(db)).toBe(1200);
    expect(pruneCache(db, T + 10, 1000)).toBe(1);
    expect(db.select().from(outsideCache).all().map((r) => r.key).sort()).toEqual(["b", "c"]);
  });

  it("runs all deletes in one transaction: a failing delete leaves every row in place", () => {
    const db = createDb(":memory:");
    putCached(db, { key: "old", source: "mycardfolio", kind: "search_empty", body: "o", nowMs: T - 2 * DAY });
    for (const [i, k] of ["a", "b", "c"].entries()) putCached(db, { key: k, source: "mycardfolio", kind: "card", body: "x".repeat(400), nowMs: T + i });
    // A guard inside SQLite that refuses to delete "b" halfway through the prune.
    db.run(sql.raw("CREATE TRIGGER keep_b BEFORE DELETE ON outside_cache WHEN old.key = 'b' BEGIN SELECT RAISE(ABORT, 'kept'); END;"));
    expect(() => pruneCache(db, T + 10, 400)).toThrow();
    // The expired row was deleted in an earlier statement before "b" failed: rolled back with it.
    expect(db.select().from(outsideCache).all().map((r) => r.key).sort()).toEqual(["a", "b", "c", "old"]);
    db.run(sql.raw("DROP TRIGGER keep_b;"));
    expect(pruneCache(db, T + 10, 400)).toBe(3);
    expect(db.select().from(outsideCache).all().map((r) => r.key)).toEqual(["c"]);
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
