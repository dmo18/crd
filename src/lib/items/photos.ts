import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, type ImageRow } from "@/db/schema";
import type { Box } from "@/lib/recognition/types";
import { EditError, JOB_TIMEOUT_MESSAGE, lockPhoto, runOneAtATime, type PhotoEdit } from "@/lib/images/edit";
import {
  ARCHIVE_EDGE, deleteStored, ImageError, keepAsOriginal, removeNamed, restoreOriginal, sameFamily, saveUpload,
  SOURCE_ARCHIVE_EDGE, writeEdited, writeFixed, type StoredImage, type Turn,
} from "@/lib/images/store";

export type PhotoResult = { ok: true; imageId: number } | { ok: false; error: string };
const fail = (error: string): PhotoResult => ({ ok: false, error });
const BUSY = "This photo is being changed right now. Try again in a moment.";
const CHANGED = "This photo changed while you were working. Nothing was saved. Try again.";
const NOT_FOUND = "That photo was not found.";
const NO_SOURCE_REPLACE = "A whole-sheet photo cannot be replaced. Add a new scan instead.";
const failed = (e: unknown, fallback: string) => fail(e instanceof ImageError || e instanceof EditError ? e.userMessage : fallback);

/** Saves an upload in the picture line; a late finish after the time limit removes its own files. */
function saveQueued(data: Buffer): Promise<StoredImage> {
  return runOneAtATime(async (ctl) => {
    const stored = await saveUpload(data);
    if (ctl.expired()) {
      await deleteStored(stored.file).catch(() => {});
      throw new EditError(JOB_TIMEOUT_MESSAGE);
    }
    return stored;
  });
}

/** The photo, only when it belongs to this item and the item is not in Recently deleted. */
function ownPhoto(db: Db, itemId: number, imageId: number): ImageRow | null {
  const row = db.select({ image: images }).from(images).innerJoin(items, eq(images.itemId, items.id))
    .where(and(eq(images.id, imageId), eq(images.itemId, itemId), isNull(items.deletedAt))).get();
  return row?.image ?? null;
}

const sameRow = (a: ImageRow, b: ImageRow | undefined) =>
  !!b && a.file === b.file && a.thumbFile === b.thumbFile && a.workFile === b.workFile && a.originalFile === b.originalFile;

const fields = (s: StoredImage) => ({ file: s.file, thumbFile: s.thumbFile, workFile: s.workFile, width: s.width, height: s.height, bytes: s.bytes, thumbBytes: s.thumbBytes });

/**
 * Turns or trims a photo. The first edit keeps the photo as its original.
 * Order: new files written, the row switched in one transaction, old files
 * removed after. A failure at any step leaves the old photo showing.
 */
export async function editPhoto(input: { itemId: number; imageId: number; edit: PhotoEdit }, db: Db = getDb()): Promise<PhotoResult> {
  const row = ownPhoto(db, input.itemId, input.imageId);
  if (!row) return fail(NOT_FOUND);
  return changePhoto(row, db, (edge) => writeEdited(row, input.edit, edge));
}

/**
 * The automatic fix after a scan: turn and cut a photo in one step, recorded
 * exactly like a turn and trim made by hand (the first change keeps the
 * untouched photo as the original). Works on a scan's photo before it
 * belongs to an item.
 */
export async function fixPhoto(row: ImageRow, fix: { turn: Turn; box: Box | null }, db: Db = getDb()): Promise<PhotoResult> {
  return changePhoto(row, db, (edge) => writeFixed(row, fix, edge));
}

async function changePhoto(row: ImageRow, db: Db, write: (edge: number) => Promise<StoredImage>): Promise<PhotoResult> {
  const release = lockPhoto(row.id);
  if (!release) return fail(BUSY);
  try {
    return await runOneAtATime(async (ctl) => {
      const edge = row.role === "source" ? SOURCE_ARCHIVE_EDGE : ARCHIVE_EDGE;
      let written: StoredImage | null = null;
      let madeCopy: string | null = null;
      try {
        written = await write(edge);
        if (ctl.expired()) throw new EditError(JOB_TIMEOUT_MESSAGE);
        const firstEdit = row.originalFile == null;
        const original = firstEdit ? await keepAsOriginal(row) : row.originalFile!;
        if (firstEdit && row.workFile) madeCopy = original;
        const stale = db.transaction((tx) => {
          const current = tx.select().from(images).where(eq(images.id, row.id)).get();
          if (!sameRow(row, current)) return true;
          tx.update(images).set({ ...fields(written!), originalFile: original }).where(eq(images.id, row.id)).run();
          return false;
        }, { behavior: "immediate" });
        if (stale) {
          await deleteStored(written.file).catch(() => {});
          if (madeCopy) await removeNamed(madeCopy);
          return fail(CHANGED);
        }
        // The row now points at the new files; remove what they replaced.
        if (firstEdit) {
          await removeNamed(row.thumbFile);
          if (row.workFile) await removeNamed(row.workFile, true);
        } else if (!sameFamily(row.file, original)) {
          await deleteStored(row.file).catch(() => {});
        }
        return { ok: true, imageId: row.id } as const;
      } catch (e) {
        if (written) await deleteStored(written.file).catch(() => {});
        if (madeCopy) await removeNamed(madeCopy);
        // A missing file because the archiver replaced the working copy meanwhile is a change, not a missing photo.
        if (e instanceof ImageError && !sameRow(row, db.select().from(images).where(eq(images.id, row.id)).get())) return fail(CHANGED);
        return failed(e, "Could not change the photo. The old photo is unchanged.");
      }
    }).catch((e) => failed(e, "Could not change the photo. The old photo is unchanged."));
  } finally {
    release();
  }
}

/** Puts the kept original back, byte for byte, and removes the edited files. */
export async function restorePhoto(input: { itemId: number; imageId: number }, db: Db = getDb()): Promise<PhotoResult> {
  const row = ownPhoto(db, input.itemId, input.imageId);
  if (!row) return fail(NOT_FOUND);
  if (!row.originalFile) return fail("This photo has not been changed, so there is no original to go back to.");
  const release = lockPhoto(row.id);
  if (!release) return fail(BUSY);
  try {
    return await runOneAtATime(async () => {
      try {
        const restored = await restoreOriginal(row.originalFile!);
        const stale = db.transaction((tx) => {
          const current = tx.select().from(images).where(eq(images.id, row.id)).get();
          if (!sameRow(row, current)) return true;
          tx.update(images).set({ ...fields(restored), originalFile: null }).where(eq(images.id, row.id)).run();
          return false;
        }, { behavior: "immediate" });
        if (stale) return fail(CHANGED);
        if (!sameFamily(row.file, row.originalFile!)) await deleteStored(row.file).catch(() => {});
        return { ok: true, imageId: row.id } as const;
      } catch (e) {
        return failed(e, "Could not put the original back. The photo is unchanged.");
      }
    }).catch((e) => failed(e, "Could not put the original back. The photo is unchanged."));
  } finally {
    release();
  }
}

/** A front is a front or a scan's crop; a back is a back. */
const ROLE_GROUP = { front: ["front", "crop"], back: ["back"] } as const;

/** Adds a front or back photo to an item that has none of that kind. */
export async function addPhoto(input: { itemId: number; role: "front" | "back"; data: Buffer }, db: Db = getDb()): Promise<PhotoResult> {
  const item = db.select({ id: items.id }).from(items).where(and(eq(items.id, input.itemId), isNull(items.deletedAt))).get();
  if (!item) return fail("That item was not found.");
  const taken = () => db.select({ id: images.id }).from(images)
    .where(and(eq(images.itemId, input.itemId), inArray(images.role, [...ROLE_GROUP[input.role]]))).get();
  const already = `This card already has a ${input.role} photo. Open it and use Replace.`;
  if (taken()) return fail(already);
  let stored: StoredImage;
  try {
    stored = await saveQueued(input.data);
  } catch (e) {
    return failed(e, "Could not save the photo. Try again.");
  }
  const id = db.transaction((tx) => {
    if (taken()) return null;
    return tx.insert(images).values({ itemId: input.itemId, role: input.role, ...stored }).returning({ id: images.id }).get().id;
  }, { behavior: "immediate" });
  if (id == null) {
    await deleteStored(stored.file).catch(() => {});
    return fail(already);
  }
  return { ok: true, imageId: id };
}

/** Swaps a photo for a new upload. The old files and any kept original go only after the new row is stored. */
export async function replacePhoto(input: { itemId: number; imageId: number; data: Buffer }, db: Db = getDb()): Promise<PhotoResult> {
  const row = ownPhoto(db, input.itemId, input.imageId);
  if (!row) return fail(NOT_FOUND);
  if (row.role === "source") return fail(NO_SOURCE_REPLACE);
  const release = lockPhoto(row.id);
  if (!release) return fail(BUSY);
  try {
    let stored: StoredImage;
    try {
      stored = await saveQueued(input.data);
    } catch (e) {
      return failed(e, "Could not save the photo. Try again.");
    }
    const stale = db.transaction((tx) => {
      const current = tx.select().from(images).where(eq(images.id, row.id)).get();
      if (!sameRow(row, current)) return true;
      tx.update(images).set({ ...fields(stored), originalFile: null }).where(eq(images.id, row.id)).run();
      return false;
    }, { behavior: "immediate" });
    if (stale) {
      await deleteStored(stored.file).catch(() => {});
      return fail(CHANGED);
    }
    await deleteStored(row.file).catch(() => {});
    if (row.originalFile && !sameFamily(row.originalFile, row.file)) await deleteStored(row.originalFile).catch(() => {});
    return { ok: true, imageId: row.id };
  } finally {
    release();
  }
}
