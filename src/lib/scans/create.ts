import { count, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, locations, scans, type ScanMode } from "@/db/schema";
import { MAX_BATCH_PHOTOS } from "./batch-limits";
import { deleteStored, ImageError, MAX_PHOTOS_PER_SCAN, saveUpload, type StoredImage } from "@/lib/images/store";

export type ScanPhotoRole = "front" | "back" | "source";
export type ScanPhotoInput = { role: ScanPhotoRole; data: Buffer };

/** Thrown with a message that is safe to show to the owner. */
export class ScanInputError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "ScanInputError";
  }
}

export const BATCH_FULL = `This upload already has ${MAX_BATCH_PHOTOS} cards. Start a new one.`;

/** How many photos each kind of scan accepts. */
export const PHOTO_RULES: Record<ScanMode, { min: number; max: number }> = {
  single: { min: 1, max: 2 },
  multi: { min: 1, max: MAX_PHOTOS_PER_SCAN },
  sealed: { min: 1, max: 4 },
  bulk: { min: 1, max: 4 },
};

function checkPhotos(mode: ScanMode, photos: ScanPhotoInput[]) {
  const rule = PHOTO_RULES[mode];
  if (photos.length < rule.min) throw new ScanInputError("Add at least one photo.");
  if (photos.length > rule.max) throw new ScanInputError(`That is too many photos. The limit here is ${rule.max}.`);
  if (mode === "single") {
    const fronts = photos.filter((p) => p.role === "front").length;
    const backs = photos.filter((p) => p.role === "back").length;
    if (fronts !== 1 || backs > 1 || fronts + backs !== photos.length) {
      throw new ScanInputError("A single card scan needs one front photo and, if you like, one back photo.");
    }
  } else if (photos.some((p) => p.role !== "source")) {
    throw new ScanInputError("Those photos do not fit this kind of scan.");
  }
}

/**
 * Saves the photos and creates a queued scan. Nothing is recognized yet;
 * call enqueueScan with the returned id.
 */
export async function createScan(
  input: { mode: ScanMode; hint?: string | null; locationId?: number | null; clientKey?: string | null; batchKey?: string | null; photos: ScanPhotoInput[] },
  db: Db = getDb(),
): Promise<{ scanId: number; duplicate: boolean }> {
  checkPhotos(input.mode, input.photos);
  const clientKey = input.clientKey ?? null;
  const existingId = () => clientKey === null ? undefined
    : db.select({ id: scans.id }).from(scans).where(eq(scans.clientKey, clientKey)).get()?.id;
  // A repeat of an upload we already have: save nothing, answer with the same scan.
  const seen = existingId();
  if (seen !== undefined) return { scanId: seen, duplicate: true };
  const batchKey = input.batchKey ?? null;
  const batchFull = () => batchKey !== null
    && (db.select({ n: count() }).from(scans).where(eq(scans.batchKey, batchKey)).get()?.n ?? 0) >= MAX_BATCH_PHOTOS;
  // The server's own cap per upload; a resend of a saved scan was answered above.
  if (batchFull()) throw new ScanInputError(BATCH_FULL);
  const hint = input.hint?.trim().slice(0, 200) || null;

  let locationId: number | null = null;
  if (input.locationId != null) {
    const found = db.select({ id: locations.id }).from(locations).where(eq(locations.id, input.locationId)).get();
    if (!found) throw new ScanInputError("That storage location no longer exists.");
    locationId = found.id;
  }

  const stored: { role: ScanPhotoRole; image: StoredImage }[] = [];
  try {
    for (const photo of input.photos) {
      stored.push({ role: photo.role, image: await saveUpload(photo.data, { manyCards: input.mode === "multi" }) });
    }
    return db.transaction((tx) => {
      if (batchFull()) throw new ScanInputError(BATCH_FULL);
      const scan = tx.insert(scans).values({ mode: input.mode, hint, locationId, clientKey, batchKey: input.batchKey ?? null }).returning({ id: scans.id }).get();
      for (const s of stored) {
        tx.insert(images).values({ scanId: scan.id, role: s.role, ...s.image }).run();
      }
      return { scanId: scan.id, duplicate: false };
    });
  } catch (err) {
    // Do not leave orphan files behind when anything fails part way.
    await Promise.all(stored.map((s) => deleteStored(s.image.file).catch(() => undefined)));
    // Two sends of the same key raced and the other one won: use its scan.
    const winner = existingId();
    if (winner !== undefined) return { scanId: winner, duplicate: true };
    if (err instanceof ImageError) throw new ScanInputError(err.userMessage);
    throw err;
  }
}
