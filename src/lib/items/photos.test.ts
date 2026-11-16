import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items } from "@/db/schema";
import { convertPhoto } from "@/lib/images/archive";
import { removeOrphanPhotos } from "@/lib/images/cleanup";
import { photoEditSchema, runOneAtATime } from "@/lib/images/edit";
import { readStored, saveUpload, uploadsDir } from "@/lib/images/store";
import { purgeItems, softDeleteItems } from "./bin";
import { mergeInto } from "./duplicates";
import { addPhoto, editPhoto, replacePhoto, restorePhoto } from "./photos";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const jpeg = (w = 900, h = 1200) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).jpeg().toBuffer();
const exists = (f: string) => fs.access(path.join(uploadsDir(), f)).then(() => true, () => false);
const workExists = (f: string) => fs.access(path.join(uploadsDir(), "work", f)).then(() => true, () => false);
const turn = (direction: "left" | "right" = "right") => ({ kind: "turn", direction }) as const;
const trim = (v: Partial<Record<"top" | "bottom" | "left" | "right", number>>) => ({ kind: "trim", top: 0, bottom: 0, left: 0, right: 0, ...v }) as const;

function newItem(title = "Card"): number {
  return db.insert(items).values({ kind: "card", title, status: "confirmed" }).returning({ id: items.id }).get().id;
}
/** A photo for an item as an uploaded photo is: a working copy until it is converted. */
async function photoFor(itemId: number, opts: { archived?: boolean; role?: "front" | "back" | "crop"; w?: number; h?: number } = {}) {
  const stored = await saveUpload(await jpeg(opts.w, opts.h));
  const id = db.insert(images).values({ itemId, role: opts.role ?? "front", ...stored }).returning({ id: images.id }).get().id;
  if (opts.archived) await convertPhoto(db, db.select().from(images).where(eq(images.id, id)).get()!);
  return id;
}
const row = (id: number) => db.select().from(images).where(eq(images.id, id)).get()!;

describe("photoEditSchema", () => {
  it("refuses numbers outside 0 to 40 and fractions", () => {
    for (const bad of [-1, 41, 100, 1.5, Number.NaN]) {
      expect(photoEditSchema.safeParse(trim({ top: bad })).success).toBe(false);
    }
    expect(photoEditSchema.safeParse(trim({ top: 40, left: 0 })).success).toBe(true);
  });
});

describe("turn and trim", () => {
  it("four turns give the first size back, one turn swaps the sides", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true, w: 600, h: 400 });
    const first = { w: row(id).width, h: row(id).height };
    expect((await editPhoto({ itemId: item, imageId: id, edit: turn("right") }, db)).ok).toBe(true);
    expect({ w: row(id).width, h: row(id).height }).toEqual({ w: first.h, h: first.w });
    for (const d of ["right", "left", "left"] as const) await editPhoto({ itemId: item, imageId: id, edit: turn(d) }, db);
    expect({ w: row(id).width, h: row(id).height }).toEqual(first);
    // Four turns, still one original.
    expect(db.select().from(images).all()).toHaveLength(1);
  }, 120_000);

  it("a trim cuts the chosen share and refuses to leave less than 200 pixels", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true, w: 800, h: 1000 });
    const before = row(id);
    const tooMuch = await editPhoto({ itemId: item, imageId: id, edit: trim({ left: 40, right: 40 }) }, db);
    expect(tooMuch.ok).toBe(false);
    expect(row(id)).toEqual(before);
    const small = await photoFor(item, { archived: true, role: "back", w: 300, h: 300 });
    const refused = await editPhoto({ itemId: item, imageId: small, edit: trim({ top: 20, bottom: 20 }) }, db);
    expect(refused).toEqual({ ok: false, error: "That would leave too little of the photo. Trim less." });
    const nothing = await editPhoto({ itemId: item, imageId: id, edit: trim({}) }, db);
    expect(nothing.ok).toBe(false);
    expect((await editPhoto({ itemId: item, imageId: id, edit: trim({ left: 10, right: 10, top: 20 }) }, db)).ok).toBe(true);
    expect(row(id).width).toBe(640);
    expect(row(id).height).toBe(800);
  }, 120_000);

  it("a photo of another item is refused and nothing changes", async () => {
    const a = newItem("A");
    const b = newItem("B");
    const id = await photoFor(a, { archived: true });
    const before = row(id);
    const r = await editPhoto({ itemId: b, imageId: id, edit: turn() }, db);
    expect(r.ok).toBe(false);
    expect((await restorePhoto({ itemId: b, imageId: id }, db)).ok).toBe(false);
    expect((await replacePhoto({ itemId: b, imageId: id, data: await jpeg() }, db)).ok).toBe(false);
    expect(row(id)).toEqual(before);
  }, 120_000);

  it("a failed picture job leaves the old photo in place and no new files", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    const before = row(id);
    const filesBefore = (await fs.readdir(uploadsDir())).sort();
    await fs.writeFile(path.join(uploadsDir(), before.file), "not a picture");
    const r = await editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    expect(r.ok).toBe(false);
    expect(row(id)).toEqual(before);
    expect((await fs.readdir(uploadsDir())).sort()).toEqual(filesBefore);
  }, 120_000);

  it("a photo that is being edited refuses a second edit at the same time", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    const [a, b] = await Promise.all([
      editPhoto({ itemId: item, imageId: id, edit: turn() }, db),
      editPhoto({ itemId: item, imageId: id, edit: turn() }, db),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  }, 120_000);

  it("times one turn of a 1600 pixel photo", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true, w: 1600, h: 1200 });
    const t0 = Date.now();
    expect((await editPhoto({ itemId: item, imageId: id, edit: turn() }, db)).ok).toBe(true);
    const ms = Date.now() - t0;
    console.log(`TIMING one turn of a photo: ${ms} ms`);
    expect(ms).toBeLessThan(6000);
  }, 120_000);
});

describe("the original", () => {
  it("is kept once and restored with the same bytes", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    const first = row(id);
    const bytes = await readStored(first.file);
    await editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    const afterOne = row(id);
    expect(afterOne.originalFile).toBe(first.file);
    expect(afterOne.file).not.toBe(first.file);
    expect(await exists(first.thumbFile)).toBe(false);
    await editPhoto({ itemId: item, imageId: id, edit: trim({ top: 10 }) }, db);
    const afterTwo = row(id);
    expect(afterTwo.originalFile).toBe(first.file);
    expect(await exists(afterOne.file)).toBe(false);
    expect((await restorePhoto({ itemId: item, imageId: id }, db)).ok).toBe(true);
    const back = row(id);
    expect(back.file).toBe(first.file);
    expect(back.originalFile).toBeNull();
    expect(Buffer.compare(await readStored(back.file), bytes)).toBe(0);
    expect(await exists(back.thumbFile)).toBe(true);
    expect(await exists(afterTwo.file)).toBe(false);
    expect(await exists(afterTwo.thumbFile)).toBe(false);
    expect((await restorePhoto({ itemId: item, imageId: id }, db)).ok).toBe(false);
  }, 120_000);

  it("of a photo still in its working copy is kept as a JPEG with the same bytes", async () => {
    const item = newItem();
    const id = await photoFor(item);
    const first = row(id);
    const workBytes = await fs.readFile(path.join(uploadsDir(), "work", first.workFile!));
    expect((await editPhoto({ itemId: item, imageId: id, edit: turn() }, db)).ok).toBe(true);
    const edited = row(id);
    expect(edited.workFile).toBeNull();
    expect(edited.originalFile).toMatch(/\.jpg$/);
    expect(await workExists(first.workFile!)).toBe(false);
    expect(Buffer.compare(await readStored(edited.originalFile!), workBytes)).toBe(0);
    expect((await restorePhoto({ itemId: item, imageId: id }, db)).ok).toBe(true);
    expect(Buffer.compare(await readStored(row(id).file), workBytes)).toBe(0);
  }, 120_000);

  it("goes with the photo: emptying the bin removes it", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    await editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    const r = row(id);
    softDeleteItems([item], db);
    expect(await exists(r.originalFile!)).toBe(true);
    await purgeItems([item], db);
    expect(await exists(r.originalFile!)).toBe(false);
    expect(await exists(r.file)).toBe(false);
  }, 120_000);

  it("moves with the photo: a merge moves the other record's photo and its original, byte for byte", async () => {
    const same = { kind: "card", title: "Griffey", player: "Ken Griffey Jr.", year: 1989, brand: "Upper Deck", cardNumber: "1", status: "confirmed" } as const;
    const keep = db.insert(items).values(same).returning({ id: items.id }).get().id;
    const gone = db.insert(items).values({ ...same, status: "needs_review" }).returning({ id: items.id }).get().id;
    const id = await photoFor(gone, { archived: true });
    await editPhoto({ itemId: gone, imageId: id, edit: turn() }, db);
    const r = row(id);
    const before = { file: await readStored(r.file), original: await readStored(r.originalFile!) };
    const merged = mergeInto(gone, keep, db);
    expect(merged).toEqual({ ok: true, targetId: keep, movedPhotos: 1 });
    // Same row, same files, same original, now on the kept record.
    expect(row(id)).toMatchObject({ itemId: keep, file: r.file, thumbFile: r.thumbFile, originalFile: r.originalFile });
    expect(Buffer.compare(await readStored(r.file), before.file)).toBe(0);
    expect(Buffer.compare(await readStored(r.originalFile!), before.original)).toBe(0);
    expect(await exists(r.thumbFile)).toBe(true);
    // The original still works on its new record.
    expect(await restorePhoto({ itemId: keep, imageId: id }, db)).toMatchObject({ ok: true });
    expect(Buffer.compare(await readStored(row(id).file), before.original)).toBe(0);
  }, 120_000);

  it("is not an orphan while its row lives and is removed once the row is gone", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    await editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    const r = row(id);
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await removeOrphanPhotos(db, uploadsDir(), later);
    expect(await exists(r.originalFile!)).toBe(true);
    expect(await exists(r.file)).toBe(true);
    db.delete(images).where(eq(images.id, id)).run();
    await removeOrphanPhotos(db, uploadsDir(), later);
    expect(await exists(r.originalFile!)).toBe(false);
    expect(await exists(r.file)).toBe(false);
  }, 120_000);

  it("a replace removes the old photo and its original after the new row is stored", async () => {
    const item = newItem();
    const id = await photoFor(item, { archived: true });
    await editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    const old = row(id);
    expect((await replacePhoto({ itemId: item, imageId: id, data: await jpeg(500, 700) }, db)).ok).toBe(true);
    const now = row(id);
    expect(now.originalFile).toBeNull();
    expect(now.file).not.toBe(old.file);
    for (const f of [old.file, old.originalFile!, old.thumbFile]) expect(await exists(f)).toBe(false);
    expect(await workExists(now.workFile!)).toBe(true);
  }, 120_000);
});

describe("adding a photo later", () => {
  it("adds one front and one back, and a scan crop counts as the front", async () => {
    const item = newItem();
    const data = await jpeg();
    expect((await addPhoto({ itemId: item, role: "back", data }, db)).ok).toBe(true);
    expect((await addPhoto({ itemId: item, role: "back", data }, db)).ok).toBe(false);
    expect((await addPhoto({ itemId: item, role: "front", data }, db)).ok).toBe(true);
    expect((await addPhoto({ itemId: item, role: "front", data }, db)).ok).toBe(false);
    const other = newItem("Scanned");
    await photoFor(other, { role: "crop" });
    expect((await addPhoto({ itemId: other, role: "front", data }, db)).ok).toBe(false);
    expect((await addPhoto({ itemId: other, role: "back", data }, db)).ok).toBe(true);
  }, 120_000);

  it("refuses a file that is not a picture and writes nothing", async () => {
    const item = newItem();
    const before = await fs.readdir(uploadsDir()).catch(() => [] as string[]);
    const r = await addPhoto({ itemId: item, role: "back", data: Buffer.from("hello, not a picture") }, db);
    expect(r.ok).toBe(false);
    expect(db.select().from(images).all()).toHaveLength(0);
    expect(await fs.readdir(uploadsDir()).catch(() => [] as string[])).toEqual(before);
  });

  it("refuses a file over 15 MB and an item that is in Recently deleted", async () => {
    const item = newItem();
    const big = await addPhoto({ itemId: item, role: "back", data: Buffer.alloc(15 * 1024 * 1024 + 1) }, db);
    expect(big).toEqual({ ok: false, error: "That photo is too large. The limit is 15 MB." });
    softDeleteItems([item], db);
    expect((await addPhoto({ itemId: item, role: "back", data: await jpeg() }, db)).ok).toBe(false);
  });

describe("photo tool edge cases", () => {
  it("answers with the changed message when the working copy vanished because the archiver replaced it", async () => {
    const item = newItem();
    const id = await photoFor(item);
    const before = row(id);
    // Hold the picture line so the edit has read the photo but not started yet.
    let release!: () => void;
    const hold = runOneAtATime(() => new Promise<void>((r) => { release = r; }));
    const pending = editPhoto({ itemId: item, imageId: id, edit: turn() }, db);
    // The archiver swaps the files and removes the working copy meanwhile.
    await fs.rm(path.join(uploadsDir(), "work", before.workFile!));
    db.update(images).set({ workFile: null, file: "other.avif" }).where(eq(images.id, id)).run();
    release();
    await hold;
    const res = await pending;
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/changed while you were working/);
  });

  it("refuses to replace a whole-sheet source photo", async () => {
    const item = newItem();
    const id = await photoFor(item);
    db.update(images).set({ role: "source" }).where(eq(images.id, id)).run();
    const res = await replacePhoto({ itemId: item, imageId: id, data: await jpeg() }, db);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: expect.stringMatching(/cannot be replaced/) });
  });
});

});
