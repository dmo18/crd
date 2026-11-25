import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { env } from "@/lib/env";
import type { Box } from "@/lib/recognition/types";
import { applyEdit, type PhotoEdit } from "./edit";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS_PER_SCAN = 12;

/**
 * Two forms of every photo:
 * - a working copy: JPEG up to 2000 px, kept only while card reading may
 *   still need it, in DATA_DIR/uploads/work;
 * - the archive: AVIF, long edge 1200 px for a card (1600 px for a scan's
 *   whole photo of several items), plus a 320 px AVIF small picture, in
 *   DATA_DIR/uploads.
 * Settings were picked by measuring: at quality 50, effort 4 and 4:2:0
 * colour, small print and card edges stay clean at about a tenth of the
 * old JPEG size.
 */
const WORK_EDGE = 2000;
export const ARCHIVE_EDGE = 1200;
export const SOURCE_ARCHIVE_EDGE = 1600;
const THUMB_EDGE = 320;
const AVIF = { quality: 50, effort: 4, chromaSubsampling: "4:2:0" } as const;
const MIN_SIDE = 100;
const MIN_CROP_PX = 16;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const NAME_RE = new RegExp(`^(${UUID})(_t)?\\.(jpg|avif)$`);
const WORK_NAME_RE = new RegExp(`^(${UUID})\\.jpg$`);
/** Half written archive files. Left over only if the server stopped mid-write. */
export const TEMP_NAME_RE = new RegExp(`^${UUID}(_t)?\\.avif\\.tmp$`);
const NOT_A_PHOTO = "That file is not a photo we can read. Use JPEG, PNG or WebP.";

export class ImageError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "ImageError";
    this.userMessage = userMessage;
  }
}

/** A photo as stored: matches the columns of the images table. */
export type StoredImage = {
  file: string;
  thumbFile: string;
  workFile: string | null;
  width: number;
  height: number;
  bytes: number;
  thumbBytes: number;
};
export type PhotoFormat = "jpeg" | "avif";

const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;

export function uploadsDir(): string {
  return path.resolve(env().DATA_DIR, "uploads");
}

/** Working copies. Inside uploads, so backups of that folder include them. */
export function workDir(): string {
  return path.join(uploadsDir(), "work");
}

export function isValidImageName(name: string): boolean {
  return typeof name === "string" && NAME_RE.test(name);
}

export function isValidWorkName(name: string): boolean {
  return typeof name === "string" && WORK_NAME_RE.test(name);
}

/** The format of a stored file, from its server generated name. */
export function photoFormat(name: string): PhotoFormat {
  return name.endsWith(".avif") ? "avif" : "jpeg";
}

export function contentTypeOf(name: string): string {
  return photoFormat(name) === "avif" ? "image/avif" : "image/jpeg";
}

function idOf(name: string): string {
  const m = NAME_RE.exec(name);
  if (!m) throw new ImageError("Photo not found.");
  return m[1]!;
}

/** Validates the name and returns a path that is guaranteed to be inside the uploads folder. */
function resolveInside(file: string): string {
  if (!isValidImageName(file)) throw new ImageError("Photo not found.");
  const dir = uploadsDir();
  const full = path.resolve(dir, file);
  if (path.dirname(full) !== dir) throw new ImageError("Photo not found.");
  return full;
}

/** Same for the working area. */
function resolveWork(file: string): string {
  if (!isValidWorkName(file)) throw new ImageError("Photo not found.");
  const dir = workDir();
  const full = path.resolve(dir, file);
  if (path.dirname(full) !== dir) throw new ImageError("Photo not found.");
  return full;
}

const archiveName = (id: string) => `${id}.avif`;
const thumbName = (id: string) => `${id}_t.avif`;
const workName = (id: string) => `${id}.jpg`;

function avif(pipeline: Sharp, edge: number): Sharp {
  // sharp keeps no metadata unless asked, so EXIF, GPS and ICC are dropped.
  return pipeline.resize(edge, edge, { fit: "inside", withoutEnlargement: true }).avif(AVIF);
}

/** Writes through a temporary name, so a crash never leaves a half written photo under the real name. */
async function writeAtomic(full: string, data: Buffer): Promise<void> {
  const tmp = `${full}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, full);
}

/**
 * Saves a working copy (JPEG) and the small picture (AVIF). The archive copy
 * is made later by archivePhoto, once card reading is finished.
 */
async function writeWorking(pipeline: () => Sharp): Promise<StoredImage> {
  const dir = uploadsDir();
  const work = workDir();
  await fs.mkdir(work, { recursive: true });
  const id = crypto.randomUUID();
  const main = await pipeline()
    .resize(WORK_EDGE, WORK_EDGE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await avif(sharp(main.data, DECODE_OPTIONS), THUMB_EDGE).toBuffer();
  const out: StoredImage = {
    file: archiveName(id), thumbFile: thumbName(id), workFile: workName(id),
    width: main.info.width, height: main.info.height, bytes: main.data.length, thumbBytes: thumb.length,
  };
  try {
    await fs.writeFile(path.join(work, out.workFile!), main.data, { flag: "wx" });
    await fs.writeFile(path.join(dir, out.thumbFile), thumb, { flag: "wx" });
  } catch {
    await deleteStored(out.file).catch(() => {});
    throw new ImageError("Could not save the photo. Try again.");
  }
  return out;
}

export async function saveUpload(input: Buffer): Promise<StoredImage> {
  if (!input || input.length === 0) throw new ImageError("That file is empty.");
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageError("That photo is too large. The limit is 15 MB.");
  try {
    const meta = await sharp(input, DECODE_OPTIONS).metadata();
    if (meta.format !== "jpeg" && meta.format !== "png" && meta.format !== "webp") throw new ImageError(NOT_A_PHOTO);
    // Orientation 5 to 8 means width and height swap after rotating.
    const swapped = (meta.orientation ?? 1) >= 5;
    const w = (swapped ? meta.height : meta.width) ?? 0;
    const h = (swapped ? meta.width : meta.height) ?? 0;
    if (Math.min(w, h) < MIN_SIDE) throw new ImageError("That photo is too small.");
    return await writeWorking(() => sharp(input, DECODE_OPTIONS).rotate());
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError(NOT_A_PHOTO);
  }
}

/** Reads a file from the uploads folder exactly as stored. */
export async function readStored(file: string): Promise<Buffer> {
  const full = resolveInside(file);
  try {
    return await fs.readFile(full);
  } catch {
    throw new ImageError("Photo not found.");
  }
}

/**
 * Reads a photo for showing in the browser. A full size AVIF that is not
 * made yet falls back to its working copy, so a photo is never missing
 * between card reading and the archive step.
 */
export async function readPhoto(file: string): Promise<{ data: Buffer; contentType: string }> {
  const full = resolveInside(file);
  try {
    return { data: await fs.readFile(full), contentType: contentTypeOf(file) };
  } catch {
    // Fall through to the working copy.
  }
  if (photoFormat(file) === "avif" && !file.includes("_t.")) {
    try {
      return { data: await fs.readFile(resolveWork(workName(idOf(file)))), contentType: "image/jpeg" };
    } catch {
      // Not there either.
    }
  }
  throw new ImageError("Photo not found.");
}

type PhotoRef = { file: string; workFile: string | null };

/** The best copy of a photo to work from: the working copy when there is one, else the archive. */
async function readSource(photo: PhotoRef): Promise<Buffer> {
  if (photo.workFile) {
    try {
      return await fs.readFile(resolveWork(photo.workFile));
    } catch {
      throw new ImageError("Photo not found.");
    }
  }
  return readStored(photo.file);
}

/**
 * The photo as card reading gets it: always JPEG, and the full quality
 * working copy whenever it still exists (never the AVIF archive then).
 * An archive (a failed scan retried after its working copy was converted)
 * is turned back into JPEG, since recognizers expect JPEG.
 */
export async function readForRecognition(photo: PhotoRef): Promise<{ data: Buffer; width: number; height: number }> {
  const data = await readSource(photo);
  try {
    const meta = await sharp(data, DECODE_OPTIONS).metadata();
    if (meta.format === "jpeg") return { data, width: meta.width ?? 0, height: meta.height ?? 0 };
    const out = await sharp(data, DECODE_OPTIONS).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { data: out.data, width: out.info.width, height: out.info.height };
  } catch {
    throw new ImageError("That photo could not be read.");
  }
}

/** A turn in degrees clockwise. */
export type Turn = 0 | 90 | 180 | 270;

/** Cuts a card out of a photo (from its working copy when it has one). The crop starts as a working copy too. */
export async function cropStored(photo: PhotoRef, box: Box, padding = 0.04, turn: Turn = 0): Promise<StoredImage> {
  const input = await readSource(photo);
  try {
    const meta = await sharp(input, DECODE_OPTIONS).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) throw new ImageError("That photo could not be cropped.");
    const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
    const x0 = clamp01(box.x - padding);
    const y0 = clamp01(box.y - padding);
    const x1 = clamp01(box.x + box.w + padding);
    const y1 = clamp01(box.y + box.h + padding);
    let left = Math.floor(x0 * W);
    let top = Math.floor(y0 * H);
    let width = Math.max(MIN_CROP_PX, Math.round((x1 - x0) * W));
    let height = Math.max(MIN_CROP_PX, Math.round((y1 - y0) * H));
    width = Math.min(width, W);
    height = Math.min(height, H);
    left = Math.max(0, Math.min(left, W - width));
    top = Math.max(0, Math.min(top, H - height));
    // Cut first, then turn (a turn of 0 leaves the pixels as they are).
    const cut = await sharp(input, DECODE_OPTIONS).extract({ left, top, width, height }).png({ compressionLevel: 0 }).toBuffer();
    return await writeWorking(() => (turn ? sharp(cut).rotate(turn) : sharp(cut)));
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError("That photo could not be cropped.");
  }
}

/**
 * Writes the AVIF archive form of a photo (and a new small picture when the
 * old one is JPEG). Deletes nothing and changes no database row: the caller
 * records the result, then calls removeReplaced. Safe to repeat.
 */
export async function archivePhoto(photo: PhotoRef & { thumbFile: string }, edge: number): Promise<StoredImage> {
  const id = idOf(photo.file);
  const input = await readSource(photo);
  const dir = uploadsDir();
  try {
    const main = await avif(sharp(input, DECODE_OPTIONS), edge).toBuffer({ resolveWithObject: true });
    const file = archiveName(id);
    await writeAtomic(path.join(dir, file), main.data);
    let thumbFile = photo.thumbFile;
    let thumbBytes: number;
    if (photoFormat(photo.thumbFile) === "avif") {
      thumbBytes = (await fs.stat(resolveInside(photo.thumbFile))).size;
    } else {
      const thumb = await avif(sharp(input, DECODE_OPTIONS), THUMB_EDGE).toBuffer();
      thumbFile = thumbName(id);
      await writeAtomic(path.join(dir, thumbFile), thumb);
      thumbBytes = thumb.length;
    }
    return { file, thumbFile, workFile: null, width: main.info.width, height: main.info.height, bytes: main.data.length, thumbBytes };
  } catch {
    throw new ImageError("Could not convert the photo.");
  }
}

/**
 * After a conversion is recorded: removes the working copy and any old JPEG
 * files the archive replaced. Never removes a file named in `kept`.
 */
export async function removeReplaced(before: PhotoRef & { thumbFile: string }, kept: StoredImage): Promise<void> {
  const keep = new Set([kept.file, kept.thumbFile]);
  const paths: string[] = [];
  if (before.workFile) paths.push(resolveWork(before.workFile));
  for (const name of [before.file, before.thumbFile]) if (!keep.has(name)) paths.push(resolveInside(name));
  for (const p of paths) await fs.rm(p, { force: true }).catch(() => {});
}

/**
 * Removes archive files written by an archive step whose result was thrown
 * away. Never touches what the photo's current row (if any) still uses.
 */
export async function discardArchive(written: StoredImage, current?: PhotoRef & { thumbFile: string }): Promise<void> {
  const keepNames = new Set<string>();
  if (current) {
    keepNames.add(current.thumbFile);
    // A row with a working copy does not use its archive name yet.
    if (current.workFile == null) keepNames.add(current.file);
  }
  for (const name of [written.file, written.thumbFile]) {
    if (!keepNames.has(name)) await fs.rm(resolveInside(name), { force: true }).catch(() => {});
  }
}

/** Deletes every form of a photo: archive, small picture, old JPEGs, working copy and half written files. */
export async function deleteStored(file: string): Promise<void> {
  const id = idOf(file);
  const paths = [
    resolveInside(`${id}.jpg`), resolveInside(`${id}_t.jpg`), resolveInside(archiveName(id)), resolveInside(thumbName(id)),
    `${resolveInside(archiveName(id))}.tmp`, `${resolveInside(thumbName(id))}.tmp`, resolveWork(workName(id)),
  ];
  for (const p of paths) {
    try {
      await fs.rm(p, { force: true });
    } catch {
      throw new ImageError("Could not delete the photo.");
    }
  }
}

/**
 * Makes the edited form of a photo from its best copy, in ONE encode of the
 * full picture (plus the small picture). Writes new files under new server
 * made names and changes nothing else; the caller records them, then removes
 * what was replaced. A failure leaves nothing behind.
 */
export async function writeEdited(photo: PhotoRef, edit: PhotoEdit, edge: number): Promise<StoredImage> {
  const input = await readSource(photo);
  const id = crypto.randomUUID();
  const dir = uploadsDir();
  const out: StoredImage = { file: archiveName(id), thumbFile: thumbName(id), workFile: null, width: 0, height: 0, bytes: 0, thumbBytes: 0 };
  try {
    const meta = await sharp(input, DECODE_OPTIONS).metadata();
    const pipeline = applyEdit(input, meta.width ?? 0, meta.height ?? 0, edit, DECODE_OPTIONS);
    const main = await avif(pipeline, edge).toBuffer({ resolveWithObject: true });
    const thumb = await avif(sharp(main.data, DECODE_OPTIONS), THUMB_EDGE).toBuffer();
    out.width = main.info.width;
    out.height = main.info.height;
    out.bytes = main.data.length;
    out.thumbBytes = thumb.length;
    await writeAtomic(path.join(dir, out.file), main.data);
    await writeAtomic(path.join(dir, out.thumbFile), thumb);
    return out;
  } catch (e) {
    await deleteStored(out.file).catch(() => {});
    if (e instanceof ImageError || (e instanceof Error && e.name === "EditError")) throw e;
    throw new ImageError("Could not change the photo. The old photo is unchanged.");
  }
}

/**
 * Turns a photo and then cuts it, in ONE encode of the full picture, like
 * writeEdited (same new names, same atomic writes, nothing else touched).
 * `box` is in the photo as it is now (before the turn), as fractions. Used by
 * the automatic fix after a scan: the caller records it exactly like a turn
 * and trim made by hand, so "Back to original" brings the photo back.
 */
export async function writeFixed(photo: PhotoRef, fix: { turn: Turn; box: Box | null }, edge: number): Promise<StoredImage> {
  const input = await readSource(photo);
  const id = crypto.randomUUID();
  const dir = uploadsDir();
  const out: StoredImage = { file: archiveName(id), thumbFile: thumbName(id), workFile: null, width: 0, height: 0, bytes: 0, thumbBytes: 0 };
  try {
    const meta = await sharp(input, DECODE_OPTIONS).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) throw new ImageError("That photo could not be read.");
    let pixels: Buffer = input;
    if (fix.box) {
      const left = Math.max(0, Math.min(W - 1, Math.floor(fix.box.x * W)));
      const top = Math.max(0, Math.min(H - 1, Math.floor(fix.box.y * H)));
      const width = Math.max(MIN_CROP_PX, Math.min(W - left, Math.round(fix.box.w * W)));
      const height = Math.max(MIN_CROP_PX, Math.min(H - top, Math.round(fix.box.h * H)));
      pixels = await sharp(input, DECODE_OPTIONS).extract({ left, top, width, height }).png({ compressionLevel: 0 }).toBuffer();
    }
    const pipeline = fix.turn ? sharp(pixels, DECODE_OPTIONS).rotate(fix.turn) : sharp(pixels, DECODE_OPTIONS);
    const main = await avif(pipeline, edge).toBuffer({ resolveWithObject: true });
    // The small picture is made from the fixed photo, fitting inside its long edge.
    const thumb = await avif(sharp(main.data, DECODE_OPTIONS), THUMB_EDGE).toBuffer();
    out.width = main.info.width;
    out.height = main.info.height;
    out.bytes = main.data.length;
    out.thumbBytes = thumb.length;
    await writeAtomic(path.join(dir, out.file), main.data);
    await writeAtomic(path.join(dir, out.thumbFile), thumb);
    return out;
  } catch (e) {
    await deleteStored(out.file).catch(() => {});
    if (e instanceof ImageError) throw e;
    throw new ImageError("Could not change the photo. The old photo is unchanged.");
  }
}

/**
 * Keeps the photo as it is now as the original. A photo that still has a
 * working copy has it copied (same bytes, no encoding) to the uploads folder
 * as a JPEG, since the working area is not kept. Returns the original's name.
 */
export async function keepAsOriginal(photo: PhotoRef): Promise<string> {
  if (!photo.workFile) {
    // Already a file in the uploads folder (archive or older JPEG): it simply stays.
    await fs.access(resolveInside(photo.file)).catch(() => { throw new ImageError("Photo not found."); });
    return photo.file;
  }
  const name = `${idOf(photo.file)}.jpg`;
  try {
    await fs.copyFile(resolveWork(photo.workFile), resolveInside(name));
  } catch {
    throw new ImageError("Photo not found.");
  }
  return name;
}

/** Brings a kept original back as the photo: same file, same bytes, and a new small picture. */
export async function restoreOriginal(original: string): Promise<StoredImage> {
  const full = resolveInside(original);
  let data: Buffer;
  try {
    data = await fs.readFile(full);
  } catch {
    throw new ImageError("The original photo is no longer there.");
  }
  try {
    const id = idOf(original);
    const meta = await sharp(data, DECODE_OPTIONS).metadata();
    const thumb = await avif(sharp(data, DECODE_OPTIONS), THUMB_EDGE).toBuffer();
    const thumbFile = thumbName(id);
    await writeAtomic(path.join(uploadsDir(), thumbFile), thumb);
    return { file: original, thumbFile, workFile: null, width: meta.width ?? 0, height: meta.height ?? 0, bytes: data.length, thumbBytes: thumb.length };
  } catch {
    throw new ImageError("Could not put the original back. The photo is unchanged.");
  }
}

/** Removes one file by its server made name (the uploads folder or the working area). Never throws. */
export async function removeNamed(name: string, work = false): Promise<void> {
  try {
    await fs.rm(work ? resolveWork(name) : resolveInside(name), { force: true });
  } catch {
    // Left for the daily cleanup.
  }
}

/** The same id means the same photo family: used to never remove an original together with an edit. */
export function sameFamily(a: string, b: string): boolean {
  return idOf(a) === idOf(b);
}
