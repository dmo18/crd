import { createHash } from "node:crypto";
import { and, asc, eq, gt, lte, sum } from "drizzle-orm";
import type { Db } from "@/db";
import { outsideCache, type OUTSIDE_CACHE_KINDS } from "@/db/schema";
import type { SourceId } from "./sources";

/**
 * Stored outside answers (`outside_cache`), kept only for the bounded times
 * below, only on this private server, only to spare the source repeat calls.
 * See "Storage policy" in docs/SPEC.md.
 */

export type CacheKind = (typeof OUTSIDE_CACHE_KINDS)[number];

const DAY = 86_400_000;

/** How long each kind of answer is kept. */
export const CACHE_KEEP_MS: Record<CacheKind, number> = {
  search: 7 * DAY,
  search_empty: 1 * DAY,
  card: 30 * DAY,
  checklist: 30 * DAY,
};

/** Total size of all stored answers; the oldest go first beyond it. */
export const CACHE_CAP_BYTES = 50 * 1024 * 1024;

type Args = Record<string, string | number | boolean | null | undefined>;

function normalizeArg(v: Args[string]): string | number | boolean | null {
  if (typeof v === "string") return v.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  return v ?? null;
}

/** SHA-256 of source, tool and normalized arguments (key order and spacing do not matter). */
export function cacheKey(source: SourceId, tool: string, args: Args): string {
  const norm = Object.keys(args).sort().filter((k) => args[k] !== undefined).map((k) => [k, normalizeArg(args[k])]);
  return createHash("sha256").update(JSON.stringify([source, tool, norm])).digest("hex");
}

/** The stored answer, or null when there is none or it is too old. */
export function getCached(db: Db, key: string, nowMs: number): { kind: CacheKind; body: string } | null {
  const row = db.select({ kind: outsideCache.kind, body: outsideCache.body }).from(outsideCache)
    .where(and(eq(outsideCache.key, key), gt(outsideCache.expiresAt, new Date(nowMs)))).get();
  return row ?? null;
}

export function putCached(db: Db, entry: { key: string; source: SourceId; kind: CacheKind; body: string; nowMs: number }): void {
  const fetchedAt = new Date(entry.nowMs);
  const expiresAt = new Date(entry.nowMs + CACHE_KEEP_MS[entry.kind]);
  const bytes = Buffer.byteLength(entry.body, "utf8");
  const values = { source: entry.source, kind: entry.kind, body: entry.body, fetchedAt, expiresAt, bytes };
  db.insert(outsideCache).values({ key: entry.key, ...values })
    .onConflictDoUpdate({ target: outsideCache.key, set: values }).run();
}

/** Deletes expired answers, then the oldest until the total is under the cap. Returns rows removed. */
export function pruneCache(db: Db, nowMs: number, capBytes = CACHE_CAP_BYTES): number {
  let removed = db.delete(outsideCache).where(lte(outsideCache.expiresAt, new Date(nowMs))).run().changes;
  let total = Number(db.select({ total: sum(outsideCache.bytes) }).from(outsideCache).get()?.total ?? 0);
  if (total <= capBytes) return removed;
  const rows = db.select({ key: outsideCache.key, bytes: outsideCache.bytes }).from(outsideCache)
    .orderBy(asc(outsideCache.fetchedAt), asc(outsideCache.key)).all();
  for (const r of rows) {
    if (total <= capBytes) break;
    removed += db.delete(outsideCache).where(eq(outsideCache.key, r.key)).run().changes;
    total -= r.bytes;
  }
  return removed;
}

/** "Clear stored answers" for one source. Returns rows removed. */
export function clearCache(db: Db, source: SourceId): number {
  return db.delete(outsideCache).where(eq(outsideCache.source, source)).run().changes;
}
