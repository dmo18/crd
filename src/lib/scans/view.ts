import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, scans, type Item, type Scan } from "@/db/schema";
import { effectiveValueCents } from "@/lib/money";

export type ItemSummary = {
  id: number;
  kind: Item["kind"];
  status: Item["status"];
  title: string;
  confidence: number | null;
  quantity: number;
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  isRookie: boolean;
  rarityTier: Item["rarityTier"];
  /** File name of a small picture, for /api/images/<name>. Null when there is none. */
  thumb: string | null;
};

export type ScanView = {
  id: number;
  mode: Scan["mode"];
  status: Scan["status"];
  error: string | null;
  itemCount: number;
  createdAt: number;
  /** When processing began (ms), or null while it waits in line. */
  startedAt: number | null;
  /** While queued: its place in line, 1 meaning it runs next. Null otherwise. */
  queuePosition: number | null;
  /** The server's clock when this was read (ms), so the browser can time a scan without trusting its own clock. */
  serverTime: number;
  items: ItemSummary[];
};

/**
 * Place in line for a queued scan. Uses this server's queue order when the
 * scan is in it (a retried scan joins at the back), otherwise counts older
 * unfinished scans.
 */
function queuePositionOf(scan: Scan, order: number[], db: Db): number {
  const at = order.indexOf(scan.id);
  if (at >= 0) {
    // The scan at the head of the queue may already be running; it does not count as "in line".
    const head = at > 0 ? db.select({ status: scans.status }).from(scans).where(eq(scans.id, order[0]!)).get() : undefined;
    return at + 1 - (head?.status === "processing" ? 1 : 0);
  }
  const ahead = db.select({ n: count() }).from(scans)
    .where(and(lt(scans.id, scan.id), or(eq(scans.status, "queued"), eq(scans.status, "processing")))).get()?.n ?? 0;
  return ahead + 1;
}

/** Best small picture for each item: the crop or front photo first. */
export function thumbsFor(itemIds: number[], db: Db = getDb()): Map<number, string> {
  const out = new Map<number, string>();
  if (itemIds.length === 0) return out;
  const order = { crop: 0, front: 1, source: 2, back: 3 } as const;
  const rows = db.select({ itemId: images.itemId, role: images.role, thumbFile: images.thumbFile })
    .from(images).where(inArray(images.itemId, itemIds)).orderBy(asc(images.id)).all();
  rows.sort((a, b) => order[a.role] - order[b.role]);
  for (const r of rows) if (r.itemId != null && !out.has(r.itemId)) out.set(r.itemId, r.thumbFile);
  return out;
}

export function summarize(rows: Item[], db: Db = getDb()): ItemSummary[] {
  const thumbs = thumbsFor(rows.map((r) => r.id), db);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, title: r.title, confidence: r.confidence, quantity: r.quantity,
    valueCents: effectiveValueCents(r), lowCents: r.estLowCents, highCents: r.estHighCents,
    isRookie: r.isRookie, rarityTier: r.rarityTier, thumb: thumbs.get(r.id) ?? null,
  }));
}

export function getScanView(scanId: number, db: Db = getDb(), order: number[] = [], now: number = Date.now()): ScanView | null {
  const scan = db.select().from(scans).where(eq(scans.id, scanId)).get();
  if (!scan) return null;
  const rows = db.select().from(items).where(eq(items.scanId, scanId)).orderBy(asc(items.id)).all();
  return {
    id: scan.id, mode: scan.mode, status: scan.status, error: scan.error, itemCount: scan.itemCount,
    createdAt: scan.createdAt.getTime(), startedAt: scan.startedAt?.getTime() ?? null,
    queuePosition: scan.status === "queued" ? queuePositionOf(scan, order, db) : null,
    serverTime: now,
    items: summarize(rows, db),
  };
}

/** The most recent scans, newest first, for the rapid-fire queue list. */
export function recentScans(limit = 20, db: Db = getDb(), order: number[] = []): ScanView[] {
  const rows = db.select({ id: scans.id }).from(scans).orderBy(desc(scans.id)).limit(Math.min(Math.max(limit, 1), 50)).all();
  return rows.map((r) => getScanView(r.id, db, order)).filter((v): v is ScanView => v !== null);
}

/** Photos that belong to the scan as a whole (the uncropped originals). */
export function scanSourcePhotos(scanId: number, db: Db = getDb()) {
  return db.select({ file: images.file, thumbFile: images.thumbFile, role: images.role })
    .from(images).where(and(eq(images.scanId, scanId), inArray(images.role, ["front", "back", "source"]))).orderBy(asc(images.id)).all();
}

export type ScanStatusCounts = { reading: number; failed: number; toReview: number };

/** Small numbers for the "being read" pill: scans waiting or running, scans that failed, items to check. */
export function scanStatusCounts(db: Db = getDb()): ScanStatusCounts {
  const reading = db.select({ n: count() }).from(scans).where(inArray(scans.status, ["queued", "processing"])).get()?.n ?? 0;
  const failed = db.select({ n: count() }).from(scans).where(eq(scans.status, "failed")).get()?.n ?? 0;
  const toReview = db.select({ n: count() }).from(items).where(eq(items.status, "needs_review")).get()?.n ?? 0;
  return { reading, failed, toReview };
}

/** One small photo per scan (front first), for the Scan activity page. Null when the files are gone. */
export function scanPhotoThumbs(scanIds: number[], db: Db = getDb()): Map<number, string> {
  const out = new Map<number, string>();
  if (scanIds.length === 0) return out;
  const order = { front: 0, source: 1, back: 2, crop: 3 } as const;
  const rows = db.select({ scanId: images.scanId, role: images.role, thumbFile: images.thumbFile })
    .from(images).where(and(inArray(images.scanId, scanIds), inArray(images.role, ["front", "back", "source"]))).orderBy(asc(images.id)).all();
  rows.sort((a, b) => order[a.role] - order[b.role]);
  for (const r of rows) if (r.scanId != null && !out.has(r.scanId)) out.set(r.scanId, r.thumbFile);
  return out;
}
