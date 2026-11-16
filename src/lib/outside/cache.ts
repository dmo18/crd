import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sum } from "drizzle-orm";
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
/** A prune goes down to this share of the cap, so a full store does not prune on every write. */
export const PRUNE_TO_SHARE = 0.9;

/** The parts of a request that decide its answer. */
export type KeyedRequest = {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  /** The JSON body as sent (before JSON.stringify), or undefined for none. */
  json?: unknown;
  /** The Accept header as sent: another answer format is another answer. */
  accept?: string;
};

/** Lowercased and trimmed: only for the named free-text fields (search words). */
function foldText(v: string): string {
  return v.trim().toLowerCase();
}

/** A copy of `value` with every string under a named field folded, at any depth. */
function foldFields(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => foldFields(v, fields));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = fields.has(k) && typeof v === "string" ? foldText(v) : foldFields(v, fields);
  }
  return out;
}

/**
 * SHA-256 of the real request: method, host, path, the query sorted by name,
 * the Accept header and the JSON body exactly as sent. Only the named free-text fields (for
 * example the search words) are lowercased and trimmed first, so "Griffey"
 * and " griffey" share one stored answer; every other difference (a limit, a
 * set id, a year) gives a different key.
 */
export function requestKey(req: KeyedRequest, freeTextFields: readonly string[] = []): string {
  const fields = new Set(freeTextFields);
  const query = Object.entries(req.query ?? {})
    .map(([k, v]): [string, string] => [k, fields.has(k) ? foldText(v) : v])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const body = req.json === undefined ? null : JSON.stringify(foldFields(req.json, fields));
  return createHash("sha256")
    .update(JSON.stringify([req.method.toUpperCase(), req.host.toLowerCase(), req.path, query, req.accept ?? null, body]))
    .digest("hex");
}

/** The stored answer, or null when there is none or it is too old. */
export function getCached(db: Db, key: string, nowMs: number): { kind: CacheKind; body: string } | null {
  const row = db.select({ kind: outsideCache.kind, body: outsideCache.body }).from(outsideCache)
    .where(and(eq(outsideCache.key, key), gt(outsideCache.expiresAt, new Date(nowMs)))).get();
  return row ?? null;
}

/** Keeps one answer (replacing an older one with the same key). Returns the change of the stored total in bytes. */
export function putCached(db: Db, entry: { key: string; source: SourceId; kind: CacheKind; body: string; nowMs: number }): number {
  const fetchedAt = new Date(entry.nowMs);
  const expiresAt = new Date(entry.nowMs + CACHE_KEEP_MS[entry.kind]);
  const bytes = Buffer.byteLength(entry.body, "utf8");
  const values = { source: entry.source, kind: entry.kind, body: entry.body, fetchedAt, expiresAt, bytes };
  return db.transaction((tx) => {
    const before = tx.select({ bytes: outsideCache.bytes }).from(outsideCache).where(eq(outsideCache.key, entry.key)).get()?.bytes ?? 0;
    tx.insert(outsideCache).values({ key: entry.key, ...values })
      .onConflictDoUpdate({ target: outsideCache.key, set: values }).run();
    return bytes - before;
  });
}

/** Bytes of all stored answers together. */
export function cacheTotalBytes(db: Db): number {
  return Number(db.select({ total: sum(outsideCache.bytes) }).from(outsideCache).get()?.total ?? 0);
}

/**
 * Deletes expired answers, then, when the total is over the cap, the oldest
 * until it is at most 90% of the cap. All deletes run in one transaction:
 * either all of them happen or none. Returns rows removed.
 */
export function pruneCache(db: Db, nowMs: number, capBytes = CACHE_CAP_BYTES): number {
  const target = Math.floor(capBytes * PRUNE_TO_SHARE);
  return db.transaction((tx) => {
    let removed = tx.delete(outsideCache).where(lte(outsideCache.expiresAt, new Date(nowMs))).run().changes;
    let total = Number(tx.select({ total: sum(outsideCache.bytes) }).from(outsideCache).get()?.total ?? 0);
    if (total <= capBytes) return removed;
    const rows = tx.select({ key: outsideCache.key, bytes: outsideCache.bytes }).from(outsideCache)
      .orderBy(asc(outsideCache.fetchedAt), asc(outsideCache.key)).all();
    const doomed: string[] = [];
    for (const r of rows) {
      if (total <= target) break;
      doomed.push(r.key);
      total -= r.bytes;
    }
    for (let i = 0; i < doomed.length; i += 500) {
      removed += tx.delete(outsideCache).where(inArray(outsideCache.key, doomed.slice(i, i + 500))).run().changes;
    }
    return removed;
  });
}

/** "Clear stored answers" for one source. Returns rows removed. */
export function clearCache(db: Db, source: SourceId): number {
  return db.delete(outsideCache).where(eq(outsideCache.source, source)).run().changes;
}
