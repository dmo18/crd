import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_EDGE, archivePhoto, saveUpload, uploadsDir } from "./store";

// The owner check is covered elsewhere; here only the response matters.
vi.mock("@/lib/auth/guard", () => ({ guardApi: async () => null }));
const { GET } = await import("@/app/api/images/[file]/route");

const get = (file: string) => GET(new Request(`http://localhost/api/images/${file}`), { params: Promise.resolve({ file }) });
const upload = async () => saveUpload(await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).jpeg().toBuffer());

function expectPrivatePhoto(res: Response, type: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(type);
  expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("GET /api/images/[file]", () => {
  it("serves an AVIF archive and its small picture as AVIF, privately, for a day", async () => {
    const stored = await upload();
    const archived = await archivePhoto(stored, ARCHIVE_EDGE);
    for (const name of [archived.file, archived.thumbFile]) {
      const res = await get(name);
      expectPrivatePhoto(res, "image/avif");
      const body = Buffer.from(await res.arrayBuffer());
      expect(res.headers.get("content-length")).toBe(String(body.length));
      expect((await sharp(body).metadata()).format).toBe("heif");
    }
  });

  it("serves the working copy as JPEG until the archive exists", async () => {
    const stored = await upload();
    const res = await get(stored.file);
    expectPrivatePhoto(res, "image/jpeg");
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format).toBe("jpeg");
    // A small picture never falls back to anything else.
    await fs.rm(path.join(uploadsDir(), stored.thumbFile));
    expect((await get(stored.thumbFile)).status).toBe(404);
  });

  it("serves an older JPEG photo as JPEG", async () => {
    const name = "6f9619ff-8b86-4011-b42d-00c04fc964ff.jpg";
    await fs.mkdir(uploadsDir(), { recursive: true });
    await fs.writeFile(path.join(uploadsDir(), name), await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).jpeg().toBuffer());
    expectPrivatePhoto(await get(name), "image/jpeg");
  });

  it("answers 404 for bad and missing names", async () => {
    for (const name of ["../x.avif", "x.avif", "6f9619ff-8b86-4011-b42d-00c04fc964ff.png", "00000000-0000-4000-8000-000000000000.avif"]) {
      expect((await get(name)).status).toBe(404);
    }
  });
});

describe("POST /api/items/[id]/photos without a stated size", () => {
  it("answers 411 before reading the body", async () => {
    const { POST } = await import("@/app/api/items/[id]/photos/route");
    const req = new Request("http://localhost/api/items/1/photos", { method: "POST", body: new Uint8Array([1]).buffer, headers: { "content-type": "application/octet-stream" } });
    req.headers.delete("content-length");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(411);
    expect((await res.json()).error).toMatch(/could not be checked/);
  });
});
