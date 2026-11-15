import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import {
  cropStored,
  deleteStored,
  ImageError,
  isValidImageName,
  MAX_UPLOAD_BYTES,
  readStored,
  saveUpload,
} from "./store";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });
const uploads = () => path.resolve(env().DATA_DIR, "uploads");
const exists = (f: string) => fs.access(path.join(uploads(), f)).then(() => true, () => false);

describe("saveUpload", () => {
  it("stores a JPEG as JPEG with a thumb", async () => {
    const out = await saveUpload(await solid(800, 600).jpeg().toBuffer());
    expect(isValidImageName(out.file)).toBe(true);
    expect(out.thumbFile).toBe(out.file.replace(".jpg", "_t.jpg"));
    expect([out.width, out.height]).toEqual([800, 600]);
    const stored = await readStored(out.file);
    expect(stored.length).toBe(out.bytes);
    expect((await sharp(stored).metadata()).format).toBe("jpeg");
    const thumb = await sharp(await readStored(out.thumbFile)).metadata();
    expect(thumb.format).toBe("jpeg");
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(400);
  });

  it("re-encodes PNG and WebP as JPEG", async () => {
    for (const buf of [await solid(300, 300).png().toBuffer(), await solid(300, 300).webp().toBuffer()]) {
      const out = await saveUpload(buf);
      expect((await sharp(await readStored(out.file)).metadata()).format).toBe("jpeg");
    }
  });

  it("shrinks large images to 2000 wide", async () => {
    const out = await saveUpload(await solid(3000, 1500).jpeg().toBuffer());
    expect([out.width, out.height]).toEqual([2000, 1000]);
  });

  it("applies EXIF rotation and strips metadata", async () => {
    const input = await solid(400, 200).jpeg().withExif({ IFD0: { Copyright: "secret" } }).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const out = await saveUpload(input);
    expect([out.width, out.height]).toEqual([200, 400]);
    const meta = await sharp(await readStored(out.file)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("rejects things that are not JPEG, PNG or WebP", async () => {
    const bad = [
      await solid(300, 300).gif().toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300"/></svg>'),
      await solid(300, 300).tiff().toBuffer(),
      Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 37) % 256)),
      Buffer.alloc(0),
      Buffer.alloc(MAX_UPLOAD_BYTES + 1),
    ];
    for (const b of bad) await expect(saveUpload(b)).rejects.toBeInstanceOf(ImageError);
  });

  it("rejects tiny images", async () => {
    await expect(saveUpload(await solid(300, 90).png().toBuffer())).rejects.toThrow("too small");
  });
});

describe("names and reads", () => {
  it("validates names strictly", async () => {
    const out = await saveUpload(await solid(300, 300).jpeg().toBuffer());
    expect(isValidImageName(out.file)).toBe(true);
    expect(isValidImageName(out.thumbFile)).toBe(true);
    for (const bad of ["../x.jpg", "a.jpg", "a/b.jpg", out.file.toUpperCase(), `../${out.file}`, `${out.file}/`, out.file.replace(".jpg", ".png")]) {
      expect(isValidImageName(bad)).toBe(false);
    }
  });

  it("refuses traversal and missing files", async () => {
    await expect(readStored("../../etc/passwd")).rejects.toBeInstanceOf(ImageError);
    await expect(readStored("00000000-0000-4000-8000-000000000000.jpg")).rejects.toThrow("Photo not found.");
  });
});

describe("cropStored", () => {
  it("crops with padding", async () => {
    const src = await saveUpload(await solid(1000, 1000).jpeg().toBuffer());
    const out = await cropStored(src.file, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(out.file).not.toBe(src.file);
    expect(Math.abs(out.width - 580)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.height - 580)).toBeLessThanOrEqual(2);
    expect(await exists(out.thumbFile)).toBe(true);
  });

  it("clamps a box that runs past the edge", async () => {
    const src = await saveUpload(await solid(1000, 500).jpeg().toBuffer());
    const out = await cropStored(src.file, { x: 0.9, y: 0.9, w: 1, h: 1 });
    expect(out.width).toBeLessThanOrEqual(1000);
    expect(out.height).toBeLessThanOrEqual(500);
    expect(out.width).toBeGreaterThanOrEqual(16);
    expect(out.height).toBeGreaterThanOrEqual(16);
  });
});

describe("deleteStored", () => {
  it("removes both files and is safe twice", async () => {
    const out = await saveUpload(await solid(300, 300).jpeg().toBuffer());
    await deleteStored(out.file);
    expect(await exists(out.file)).toBe(false);
    expect(await exists(out.thumbFile)).toBe(false);
    await expect(deleteStored(out.file)).resolves.toBeUndefined();
    await expect(deleteStored("../x.jpg")).rejects.toBeInstanceOf(ImageError);
  });
});
