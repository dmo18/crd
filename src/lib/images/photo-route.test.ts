import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { saveUpload } from "./store";

// The owner check is covered elsewhere; here only the response matters.
vi.mock("@/lib/auth/guard", () => ({ guardApi: async () => null }));
const { GET } = await import("@/app/api/images/[file]/route");

describe("GET /api/images/[file]", () => {
  it("lets the browser keep a photo for a day, privately, not forever", async () => {
    const stored = await saveUpload(await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).jpeg().toBuffer());
    const res = await GET(new Request(`http://localhost/api/images/${stored.file}`), { params: Promise.resolve({ file: stored.file }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });
});
