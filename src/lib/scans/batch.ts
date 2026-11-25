import { and, desc, eq, inArray, isNotNull, isNull, max, min } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { images, items, scans } from "@/db/schema";
import { parseCatalog, type NotCheckedReason } from "@/lib/catalog/candidates";
import { liveItem } from "@/lib/items/live";
import { connectionView } from "@/lib/outside/view";
import { retryScan } from "./process";

/**
 * "Many photos, one card each": every card is its own scan in the normal
 * queue; the scans of one upload share a `batchKey` (a random id the scan
 * screen makes), so Scan activity can report on the upload as a whole.
 */

export { MAX_BATCH_PHOTOS } from "./batch-limits";
/** How many recent uploads Scan activity reports on. */
export const BATCH_REPORTS = 3;

export const batchKeySchema = z.string().uuid();

/** Catalog skipped for a reason that is a limit or the switch, not a one-off failure. */
const LIMIT_REASONS: readonly NotCheckedReason[] = ["off", "paused", "cap", "busy"];

export type BatchReport = {
  key: string;
  /** When the first scan of the upload was saved (ms). */
  startedAt: number;
  /** Scans (cards) saved for this upload. */
  scans: number;
  /** Read to the end. */
  read: number;
  /** Waiting in line or being read. */
  waiting: number;
  failed: number;
  /** Failed scans that still have their photos, so "Try the failed ones again" can run them. */
  retryable: number;
  /** Cards from this upload that wait in Review. */
  inReview: number;
  /** Cards read but not checked against the catalog because of its limit or switch. */
  catalogSkipped: number;
};

/** The latest uploads, newest first. A fixed number of queries. */
export function batchReports(db: Db = getDb(), limit = BATCH_REPORTS): BatchReport[] {
  const keys = db.select({ key: scans.batchKey, last: max(scans.id), firstAt: min(scans.createdAt) }).from(scans)
    .where(isNotNull(scans.batchKey)).groupBy(scans.batchKey).orderBy(desc(max(scans.id))).limit(Math.min(Math.max(limit, 1), 20)).all();
  if (keys.length === 0) return [];
  const list = keys.map((k) => k.key!);
  const rows = db.select({ id: scans.id, key: scans.batchKey, status: scans.status }).from(scans).where(inArray(scans.batchKey, list)).all();
  const scanBatch = new Map(rows.map((r) => [r.id, r.key!]));
  const itemRows = db.select({ scanId: items.scanId, status: items.status, catalog: items.catalogCandidates }).from(items)
    .where(and(inArray(items.scanId, [...scanBatch.keys()]), liveItem)).all();
  const retryable = new Set(retryableFailed(db, rows.filter((r) => r.status === "failed").map((r) => r.id)));
  return keys.map((k) => {
    const mine = rows.filter((r) => r.key === k.key);
    const ids = new Set(mine.map((r) => r.id));
    const cards = itemRows.filter((i) => i.scanId != null && ids.has(i.scanId));
    const skipped = cards.filter((i) => {
      const c = parseCatalog(i.catalog, new Date(), { anyAge: true });
      return c?.status === "not_checked" && c.reason !== null && LIMIT_REASONS.includes(c.reason);
    }).length;
    const raw = k.firstAt as unknown;
    return {
      key: k.key!,
      startedAt: raw instanceof Date ? raw.getTime() : Number(raw),
      scans: mine.length,
      read: mine.filter((r) => r.status === "done").length,
      waiting: mine.filter((r) => r.status === "queued" || r.status === "processing").length,
      failed: mine.filter((r) => r.status === "failed").length,
      retryable: mine.filter((r) => retryable.has(r.id)).length,
      inReview: cards.filter((i) => i.status === "needs_review").length,
      catalogSkipped: skipped,
    };
  });
}

/** Of these failed scans, the ones that still have a photo to read. */
function retryableFailed(db: Db, failedIds: number[]): number[] {
  if (failedIds.length === 0) return [];
  // Same rule as retryScan: a photo of the scan not yet given to an item.
  const rows = db.selectDistinct({ scanId: images.scanId }).from(images)
    .where(and(inArray(images.scanId, failedIds), inArray(images.role, ["front", "back", "source"]), isNull(images.itemId))).all();
  return rows.map((r) => r.scanId!).filter((id) => id != null);
}

export type BatchRetry = { ok: true; queued: number[]; gone: number } | { ok: false; status: 404; error: string };

/**
 * "Try the failed ones again": puts every failed scan of the upload back in
 * the queue with the photos it already has. Scans that were read are never
 * touched, so a finished card is never read again. Call enqueueScan for each
 * id in `queued`.
 */
export function retryBatch(key: string, db: Db = getDb()): BatchRetry {
  const all = db.select({ id: scans.id, status: scans.status }).from(scans).where(eq(scans.batchKey, key)).all();
  if (all.length === 0) return { ok: false, status: 404, error: "That upload was not found." };
  const queued: number[] = [];
  let gone = 0;
  for (const s of all) {
    if (s.status !== "failed") continue;
    const r = retryScan(s.id, db);
    if (r.ok) queued.push(s.id);
    else if (r.status === 410) gone += 1;
  }
  return { ok: true, queued, gone };
}

export type CatalogLimit =
  | { kind: "off" }
  | { kind: "paused"; untilMs: number }
  | { kind: "hour" }
  | { kind: "day" };

/** Whether the card catalog is held back by its switch or a limit right now. Null when it is free to use. */
export function catalogLimitNow(db: Db = getDb(), nowMs = Date.now()): CatalogLimit | null {
  const v = connectionView(db, "mycardfolio", nowMs);
  if (v.state.kind === "off") return { kind: "off" };
  if (v.state.kind === "paused") return { kind: "paused", untilMs: v.state.untilMs };
  if (v.usage.perDay !== null && v.usage.callsToday >= v.usage.perDay) return { kind: "day" };
  if (v.usage.perHour !== null && v.usage.callsThisHour >= v.usage.perHour) return { kind: "hour" };
  return null;
}

/** Plain words for a catalog limit. Reading goes on either way; only the catalog check waits. */
export function catalogLimitText(limit: CatalogLimit): string {
  switch (limit.kind) {
    case "off": return "The card catalog is switched off (More, Connections). Cards are still read, but not checked against the catalog.";
    case "paused": return "The card catalog asked the app to slow down, so it is paused for a while. Cards are still read; the catalog check is skipped until the pause ends.";
    case "hour": return "The card catalog's limit for this hour is used up. Cards are still read; the catalog check is skipped until the next hour.";
    case "day": return "The card catalog's limit for today is used up. Cards are still read; the catalog check is skipped until tomorrow.";
  }
}

/** The report's line about cards not checked against the catalog. */
export function catalogSkippedText(n: number): string | null {
  if (n <= 0) return null;
  return `${n === 1 ? "1 card was" : `${n} cards were`} read but not checked against the catalog because of its limit. Open ${n === 1 ? "it" : "them"} later and tap Look up again.`;
}
