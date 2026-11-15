import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import {
  ARCHIVE_EDGE,
  archivePhoto,
  contentTypeOf,
  cropStored,
  deleteStored,
  ImageError,
  isValidImageName,
  isValidWorkName,
  MAX_UPLOAD_BYTES,
  photoFormat,
  readForRecognition,
  readPhoto,
  readStored,
  saveUpload,
  SOURCE_ARCHIVE_EDGE,
} from "./store";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });
const uploads = () => path.resolve(env().DATA_DIR, "uploads");
const work = () => path.join(uploads(), "work");
const exists = (f: string) => fs.access(path.join(uploads(), f)).then(() => true, () => false);
const workExists = (f: string) => fs.access(path.join(work(), f)).then(() => true, () => false);
const readWork = (f: string) => fs.readFile(path.join(work(), f));

describe("saveUpload", () => {
  it("keeps a full quality JPEG working copy and makes a small AVIF picture", async () => {
    const out = await saveUpload(await solid(800, 600).jpeg().toBuffer());
    const id = out.file.replace(".avif", "");
    expect(out.file).toBe(`${id}.avif`);
    expect(out.thumbFile).toBe(`${id}_t.avif`);
    expect(out.workFile).toBe(`${id}.jpg`);
    expect([isValidImageName(out.file), isValidImageName(out.thumbFile), isValidWorkName(out.workFile!)]).toEqual([true, true, true]);
    expect([out.width, out.height]).toEqual([800, 600]);
    const working = await readWork(out.workFile!);
    expect(working.length).toBe(out.bytes);
    expect((await sharp(working).metadata()).format).toBe("jpeg");
    // The archive copy is made later; until then the full size photo is the working copy.
    expect(await exists(out.file)).toBe(false);
    expect(await readPhoto(out.file)).toEqual({ data: working, contentType: "image/jpeg" });
    const thumb = await readStored(out.thumbFile);
    expect(thumb.length).toBe(out.thumbBytes);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("heif");
    expect(meta.compression).toBe("av1");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(320);
  });

  it("re-encodes PNG and WebP as JPEG", async () => {
    for (const buf of [await solid(300, 300).png().toBuffer(), await solid(300, 300).webp().toBuffer()]) {
      const out = await saveUpload(buf);
      expect((await sharp(await readWork(out.workFile!)).metadata()).format).toBe("jpeg");
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
    for (const buf of [await readWork(out.workFile!), await readStored(out.thumbFile)]) {
      const meta = await sharp(buf).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
  });

  it("rejects things that are not JPEG, PNG or WebP", async () => {
    const bad = [
      await solid(300, 300).gif().toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300"/></svg>'),
      await solid(300, 300).tiff().toBuffer(),
      await solid(300, 300).avif().toBuffer(),
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
  it("accepts server names in both formats and nothing else", async () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    for (const good of [`${id}.jpg`, `${id}_t.jpg`, `${id}.avif`, `${id}_t.avif`]) expect(isValidImageName(good)).toBe(true);
    for (const bad of [
      "../x.jpg", "a.jpg", "a/b.jpg", `${id}.JPG`, `${id}.AVIF`, id.toUpperCase() + ".avif", `../${id}.avif`, `${id}.avif/`,
      `${id}.png`, `${id}.webp`, `${id}.avif.tmp`, `${id}_t_t.avif`, `${id}.jpeg`, `${id}.avif.jpg`, `work/${id}.jpg`, "",
    ]) {
      expect(isValidImageName(bad)).toBe(false);
    }
    expect(isValidWorkName(`${id}.jpg`)).toBe(true);
    expect(isValidWorkName(`${id}.avif`)).toBe(false);
    expect(isValidWorkName(`${id}_t.jpg`)).toBe(false);
    expect([photoFormat(`${id}.avif`), photoFormat(`${id}_t.jpg`)]).toEqual(["avif", "jpeg"]);
    expect([contentTypeOf(`${id}_t.avif`), contentTypeOf(`${id}.jpg`)]).toEqual(["image/avif", "image/jpeg"]);
  });

  it("refuses traversal and missing files", async () => {
    await expect(readStored("../../etc/passwd")).rejects.toBeInstanceOf(ImageError);
    await expect(readPhoto("../work/x.jpg")).rejects.toBeInstanceOf(ImageError);
    await expect(readStored("00000000-0000-4000-8000-000000000000.jpg")).rejects.toThrow("Photo not found.");
    await expect(readPhoto("00000000-0000-4000-8000-000000000000.avif")).rejects.toThrow("Photo not found.");
  });
});

describe("cropStored", () => {
  it("crops the working copy with padding, and the crop starts as a working copy", async () => {
    const src = await saveUpload(await solid(1000, 1000).jpeg().toBuffer());
    const out = await cropStored(src, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(out.file).not.toBe(src.file);
    expect(Math.abs(out.width - 580)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.height - 580)).toBeLessThanOrEqual(2);
    expect(await exists(out.thumbFile)).toBe(true);
    expect(await workExists(out.workFile!)).toBe(true);
  });

  it("clamps a box that runs past the edge", async () => {
    const src = await saveUpload(await solid(1000, 500).jpeg().toBuffer());
    const out = await cropStored(src, { x: 0.9, y: 0.9, w: 1, h: 1 });
    expect(out.width).toBeLessThanOrEqual(1000);
    expect(out.height).toBeLessThanOrEqual(500);
    expect(out.width).toBeGreaterThanOrEqual(16);
    expect(out.height).toBeGreaterThanOrEqual(16);
  });
});

describe("archivePhoto and readForRecognition", () => {
  it("makes a 1200 px AVIF (1600 px for a whole scan photo) with no metadata, and leaves the working copy", async () => {
    const input = await solid(1500, 2100).jpeg().withExif({ IFD0: { Copyright: "secret" } }).toBuffer();
    const src = await saveUpload(input);
    for (const edge of [ARCHIVE_EDGE, SOURCE_ARCHIVE_EDGE]) {
      const out = await archivePhoto(src, edge);
      expect(out).toMatchObject({ file: src.file, thumbFile: src.thumbFile, workFile: null, height: edge });
      const data = await readStored(out.file);
      expect(data.length).toBe(out.bytes);
      const meta = await sharp(data).metadata();
      expect([meta.format, meta.compression]).toEqual(["heif", "av1"]);
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    }
    expect(await workExists(src.workFile!)).toBe(true);
  });

  it("gives recognition the working copy itself while it exists, and JPEG made from the archive after", async () => {
    const src = await saveUpload(await solid(900, 1200).jpeg().toBuffer());
    const fromWork = await readForRecognition(src);
    expect(fromWork.data.equals(await readWork(src.workFile!))).toBe(true);
    expect([fromWork.width, fromWork.height]).toEqual([900, 1200]);

    const archived = await archivePhoto(src, ARCHIVE_EDGE);
    // Even with the archive on disk, the working copy wins.
    expect((await readForRecognition(src)).data.equals(fromWork.data)).toBe(true);
    const fromArchive = await readForRecognition(archived);
    expect((await sharp(fromArchive.data).metadata()).format).toBe("jpeg");
    expect([fromArchive.width, fromArchive.height]).toEqual([900, 1200]);
  });
});

describe("deleteStored", () => {
  it("removes every form of a photo and is safe twice", async () => {
    const out = await saveUpload(await solid(300, 300).jpeg().toBuffer());
    await archivePhoto(out, ARCHIVE_EDGE);
    const id = out.file.replace(".avif", "");
    // Old JPEGs and half written files with the same id go too.
    for (const extra of [`${id}.jpg`, `${id}_t.jpg`, `${id}.avif.tmp`]) await fs.writeFile(path.join(uploads(), extra), "x");
    await deleteStored(out.file);
    for (const f of [out.file, out.thumbFile, `${id}.jpg`, `${id}_t.jpg`, `${id}.avif.tmp`]) expect(await exists(f)).toBe(false);
    expect(await workExists(out.workFile!)).toBe(false);
    await expect(deleteStored(out.file)).resolves.toBeUndefined();
    await expect(deleteStored(`${id}.jpg`)).resolves.toBeUndefined();
    await expect(deleteStored("../x.jpg")).rejects.toBeInstanceOf(ImageError);
  });
});
