import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, images, items } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";
import { saveUpload } from "@/lib/images/store";

let owner = true;
class Redirected extends Error {}
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Redirected("/login"); },
  guardApi: async () => (owner ? null : Response.json({ error: "Sign in first." }, { status: 401 })),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/images/archive", async (orig) => ({ ...(await orig<typeof import("@/lib/images/archive")>()), startPhotoArchiver: () => null }));

const { editPhotoAction, restorePhotoAction } = await import("./photo-actions");
const { POST } = await import("@/app/api/items/[id]/photos/route");

const idle = { status: "idle", message: "" } as const;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const jpeg = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#336699" } }).jpeg().toBuffer();

let db: Db;
let itemId: number;
let imageId: number;
beforeEach(async () => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  owner = true;
  itemId = db.insert(items).values({ kind: "card", title: "Card", status: "confirmed" }).returning({ id: items.id }).get().id;
  imageId = db.insert(images).values({ itemId, role: "front", ...(await saveUpload(await jpeg())) }).returning({ id: images.id }).get().id;
});
afterEach(() => setDbForTests(undefined));

const post = (id: string, fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return POST(new Request(`http://localhost/api/items/${id}/photos`, { method: "POST", body: f }), { params: Promise.resolve({ id }) });
};

describe("photo actions", () => {
  it("are refused without a session and change nothing", async () => {
    owner = false;
    const before = db.select().from(images).all();
    await expect(editPhotoAction(idle, form({ itemId: String(itemId), imageId: String(imageId), kind: "turn", direction: "left" }))).rejects.toBeInstanceOf(Redirected);
    await expect(restorePhotoAction(idle, form({ itemId: String(itemId), imageId: String(imageId) }))).rejects.toBeInstanceOf(Redirected);
    expect((await post(String(itemId), { mode: "add", role: "back", photo: new Blob([await jpeg()]) })).status).toBe(401);
    expect(db.select().from(images).all()).toEqual(before);
  });

  it("refuse trim numbers outside 0 to 40, words and missing numbers", async () => {
    const base = { itemId: String(itemId), imageId: String(imageId), kind: "trim", top: "0", bottom: "0", left: "0", right: "0" };
    for (const bad of ["41", "-1", "abc", "1.5", "", "1e1"]) {
      const r = await editPhotoAction(idle, form({ ...base, left: bad }));
      expect(r.status).toBe("error");
    }
    const r = await editPhotoAction(idle, form({ itemId: String(itemId), imageId: String(imageId), kind: "trim" }));
    expect(r.status).toBe("error");
    expect((await editPhotoAction(idle, form({ ...base, kind: "spin" }))).status).toBe("error");
    expect(db.select().from(images).get()?.originalFile).toBeNull();
  });

  it("refuse an image id of another item and ids that are not whole numbers", async () => {
    const other = db.insert(items).values({ kind: "card", title: "Other", status: "confirmed" }).returning({ id: items.id }).get().id;
    const r = await editPhotoAction(idle, form({ itemId: String(other), imageId: String(imageId), kind: "turn", direction: "left" }));
    expect(r).toEqual({ status: "error", message: "That photo was not found." });
    for (const bad of ["0", "-3", "x", "1.5"]) {
      expect((await editPhotoAction(idle, form({ itemId: bad, imageId: String(imageId), kind: "turn", direction: "left" }))).status).toBe("error");
    }
  });

  it("turn a photo, write the activity log and restore it", async () => {
    const t = await editPhotoAction(idle, form({ itemId: String(itemId), imageId: String(imageId), kind: "turn", direction: "left" }));
    expect(t.status).toBe("done");
    expect(db.select().from(images).where(eq(images.id, imageId)).get()?.originalFile).not.toBeNull();
    const r = await restorePhotoAction(idle, form({ itemId: String(itemId), imageId: String(imageId) }));
    expect(r.status).toBe("done");
    expect(db.select().from(auditEvents).all().map((e) => e.event)).toEqual(["photo_edited", "photo_restored"]);
  }, 60_000);
});

describe("POST /api/items/[id]/photos", () => {
  it("adds a back photo and logs it", async () => {
    const res = await post(String(itemId), { mode: "add", role: "back", photo: new File([new Uint8Array(await jpeg())], "x.jpg", { type: "image/jpeg" }) });
    expect(res.status).toBe(200);
    expect(db.select().from(images).where(eq(images.role, "back")).all()).toHaveLength(1);
    expect(db.select().from(auditEvents).all().map((e) => e.event)).toEqual(["photo_added"]);
  }, 60_000);

  it("refuses something that is not a picture, a file over 15 MB, a bad mode and a bad item", async () => {
    const text = new File(["hello"], "x.jpg", { type: "image/jpeg" });
    expect((await post(String(itemId), { mode: "add", role: "back", photo: text })).status).toBe(422);
    const big = new File([new Uint8Array(15 * 1024 * 1024 + 1)], "x.jpg", { type: "image/jpeg" });
    expect((await post(String(itemId), { mode: "add", role: "back", photo: big })).status).toBe(413);
    expect((await post(String(itemId), { mode: "add", role: "source", photo: text })).status).toBe(400);
    expect((await post(String(itemId), { mode: "add", role: "back", photo: "not a file" })).status).toBe(400);
    expect((await post("abc", { mode: "add", role: "back", photo: text })).status).toBe(404);
    expect(db.select().from(images).all()).toHaveLength(1);
  });
});
