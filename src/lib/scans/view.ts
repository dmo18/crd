import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
  items: ItemSummary[];
};

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

export function getScanView(scanId: number, db: Db = getDb()): ScanView | null {
  const scan = db.select().from(scans).where(eq(scans.id, scanId)).get();
  if (!scan) return null;
  const rows = db.select().from(items).where(eq(items.scanId, scanId)).orderBy(asc(items.id)).all();
  return {
    id: scan.id, mode: scan.mode, status: scan.status, error: scan.error, itemCount: scan.itemCount,
    createdAt: scan.createdAt.getTime(), items: summarize(rows, db),
  };
}

/** The most recent scans, newest first, for the rapid-fire queue list. */
export function recentScans(limit = 20, db: Db = getDb()): ScanView[] {
  const rows = db.select({ id: scans.id }).from(scans).orderBy(desc(scans.id)).limit(Math.min(Math.max(limit, 1), 50)).all();
  return rows.map((r) => getScanView(r.id, db)).filter((v): v is ScanView => v !== null);
}

/** Photos that belong to the scan as a whole (the uncropped originals). */
export function scanSourcePhotos(scanId: number, db: Db = getDb()) {
  return db.select({ file: images.file, thumbFile: images.thumbFile, role: images.role })
    .from(images).where(and(eq(images.scanId, scanId), inArray(images.role, ["front", "back", "source"]))).orderBy(asc(images.id)).all();
}
