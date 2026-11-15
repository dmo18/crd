import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { env } from "@/lib/env";
import type { Box } from "@/lib/recognition/types";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS_PER_SCAN = 12;

const MAIN_EDGE = 2000;
const THUMB_EDGE = 400;
const MIN_SIDE = 100;
const MIN_CROP_PX = 16;
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(_t)?\.jpg$/;
const NOT_A_PHOTO = "That file is not a photo we can read. Use JPEG, PNG or WebP.";

export class ImageError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "ImageError";
    this.userMessage = userMessage;
  }
}

export type StoredImage = { file: string; thumbFile: string; width: number; height: number; bytes: number };

const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 50_000_000 } as const;

function uploadsDir(): string {
  return path.resolve(env().DATA_DIR, "uploads");
}

export function isValidImageName(name: string): boolean {
  return typeof name === "string" && NAME_RE.test(name);
}

/** Validates the name and returns a path that is guaranteed to be inside the uploads folder. */
function resolveInside(file: string): string {
  if (!isValidImageName(file)) throw new ImageError("Photo not found.");
  const dir = uploadsDir();
  const full = path.resolve(dir, file);
  if (path.dirname(full) !== dir) throw new ImageError("Photo not found.");
  return full;
}

function thumbNameFor(file: string): string {
  return file.replace(/(_t)?\.jpg$/, "_t.jpg");
}

async function writeVariants(pipeline: () => Sharp): Promise<StoredImage> {
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = `${id}.jpg`;
  const thumbFile = `${id}_t.jpg`;
  const main = await pipeline()
    .resize(MAIN_EDGE, MAIN_EDGE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await pipeline()
    .resize(THUMB_EDGE, THUMB_EDGE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();
  try {
    await fs.writeFile(path.join(dir, file), main.data, { flag: "wx" });
    await fs.writeFile(path.join(dir, thumbFile), thumb, { flag: "wx" });
  } catch {
    await fs.rm(path.join(dir, file), { force: true }).catch(() => {});
    await fs.rm(path.join(dir, thumbFile), { force: true }).catch(() => {});
    throw new ImageError("Could not save the photo. Try again.");
  }
  return { file, thumbFile, width: main.info.width, height: main.info.height, bytes: main.data.length };
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
    return await writeVariants(() => sharp(input, DECODE_OPTIONS).rotate());
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError(NOT_A_PHOTO);
  }
}

export async function readStored(file: string): Promise<Buffer> {
  const full = resolveInside(file);
  try {
    return await fs.readFile(full);
  } catch {
    throw new ImageError("Photo not found.");
  }
}

export async function cropStored(file: string, box: Box, padding = 0.04): Promise<StoredImage> {
  const input = await readStored(file);
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
    return await writeVariants(() => sharp(input, DECODE_OPTIONS).extract({ left, top, width, height }));
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError("That photo could not be cropped.");
  }
}

export async function deleteStored(file: string): Promise<void> {
  const full = resolveInside(file);
  const thumb = resolveInside(thumbNameFor(file));
  for (const p of new Set([full, thumb])) {
    try {
      await fs.rm(p, { force: true });
    } catch {
      throw new ImageError("Could not delete the photo.");
    }
  }
}
