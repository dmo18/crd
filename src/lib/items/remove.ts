import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { images, items, scans, valuations } from "@/db/schema";
import { deleteStored } from "@/lib/images/store";

/** The files of photo rows, each with its kept original: an original goes with its photo. */
function photoFiles(rows: { file: string; original: string | null }[]): string[] {
  return rows.flatMap((r) => (r.original ? [r.file, r.original] : [r.file]));
}

/**
 * Removes an item's database rows for good. Only purge (bin.ts) and merging
 * duplicates call this; the Delete buttons move items to Recently deleted.
 * A merge moves the item's photos to the kept record first (and keeps a
 * scan that still has photos), so for a merge this returns no files.
 * Reads the item whether or not it is in the bin. Call inside a transaction. When it was the
 * last item left from its scan (for example the last card cut out of a
 * multi-card photo), the scan's own photos and the scan itself go too.
 * Returns the photo files to delete once the transaction has committed, or
 * null when the item does not exist. Files are never touched here, so a
 * rolled back transaction cannot leave rows pointing at missing photos.
 */
export function removeItemRows(tx: Db, itemId: number): string[] | null {
  const item = tx.select({ id: items.id, scanId: items.scanId }).from(items).where(eq(items.id, itemId)).get();
  if (!item) return null;
  const files = photoFiles(tx.select({ file: images.file, original: images.originalFile }).from(images).where(eq(images.itemId, itemId)).all());
  tx.delete(images).where(eq(images.itemId, itemId)).run();
  tx.delete(valuations).where(eq(valuations.itemId, itemId)).run();
  tx.delete(items).where(eq(items.id, itemId)).run();

  if (item.scanId != null) {
    // Counts items in Recently deleted too, on purpose: they still need the scan's photos.
    const left = tx.select({ n: count() }).from(items).where(eq(items.scanId, item.scanId)).get()?.n ?? 0;
    const scan = tx.select({ status: scans.status }).from(scans).where(eq(scans.id, item.scanId)).get();
    if (left === 0 && scan?.status === "done") {
      files.push(...removeScanRows(tx, [item.scanId]));
    }
  }
  return files;
}

/** Removes scans and all their photo rows. Call inside a transaction. Returns the files to delete afterwards. */
export function removeScanRows(tx: Db, scanIds: number[]): string[] {
  if (scanIds.length === 0) return [];
  const files = photoFiles(tx.select({ file: images.file, original: images.originalFile }).from(images).where(inArray(images.scanId, scanIds)).all());
  tx.delete(images).where(inArray(images.scanId, scanIds)).run();
  // Items keep existing; they simply lose the link to a scan that is gone.
  tx.update(items).set({ scanId: null }).where(inArray(items.scanId, scanIds)).run();
  tx.delete(scans).where(inArray(scans.id, scanIds)).run();
  return files;
}

/** Deletes photo files (and their small versions). A missing file is not an error. */
export async function deletePhotoFiles(files: string[]): Promise<void> {
  for (const file of new Set(files)) {
    try {
      await deleteStored(file);
    } catch {
      // Left for the daily cleanup of photos with no database row.
    }
  }
}

/** Failed scans and their photos, removed in one go. Returns how many scans were removed. */
export async function deleteFailedScans(db: Db): Promise<number> {
  const { ids, files } = db.transaction((tx) => {
    const t = tx as unknown as Db;
    const failed = t.select({ id: scans.id }).from(scans).where(eq(scans.status, "failed")).all().map((r) => r.id);
    return { ids: failed, files: removeScanRows(t, failed) };
  }, { behavior: "immediate" });
  await deletePhotoFiles(files);
  return ids.length;
}
