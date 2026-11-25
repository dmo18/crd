import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images, items, scans } from "@/db/schema";
import { offerTrim } from "@/lib/catalog/sources";
import { removeOrphanPhotos } from "@/lib/images/cleanup";
import { ARCHIVE_EDGE, readPhoto, sameFamily, uploadsDir, workDir } from "@/lib/images/store";
import { restorePhoto } from "@/lib/items/photos";
import { recognizedItemSchema, type PhotoFix, type ReadFix, type Recognizer } from "@/lib/recognition/types";
import { createScan } from "./create";
import { processScan } from "./process";
import { planFix } from "./photo-fix";

/**
 * A made-up card photo: a dark table, a light card rectangle with dark text-like
 * marks, and a red block at the card's top edge so the turn can be checked.
 * `at` is where the red block sits on the card as it appears in the photo.
 */
async function tablePhoto(opts: { photoW: number; photoH: number; card: { x: number; y: number; w: number; h: number }; red: "left" | "right" | "top" | "bottom" }): Promise<Buffer> {
  const { photoW, photoH, card: c, red } = opts;
  const mark = 40;
  const redAt = { left: [c.x, c.y + c.h / 2 - mark], right: [c.x + c.w - mark, c.y + c.h / 2 - mark], top: [c.x + c.w / 2 - mark, c.y], bottom: [c.x + c.w / 2 - mark, c.y + c.h - mark] }[red];
  const marks = [0.3, 0.45, 0.6, 0.75].map((f) => `<rect x="${c.x + c.w * 0.2}" y="${c.y + c.h * f}" width="${c.w * 0.5}" height="14" fill="#202020"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${photoW}" height="${photoH}">
    <rect width="100%" height="100%" fill="#202020"/>
    <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#e8e8e0"/>${marks}
    <rect x="${redAt[0]}" y="${redAt[1]}" width="${mark}" height="${mark * 2}" fill="#ff0000"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const fix = (over: Partial<ReadFix> = {}): ReadFix => ({ turn: 0, turnTrusted: true, card: null, cardTrusted: false, lines: [], ...over });

/** A reader that says what it found, whatever the pixels. */
function fakeWith(fixes: (PhotoFix)[]): Recognizer {
  return {
    name: "fake-model",
    async recognize() {
      return [{ ...recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "Test Player" }), fixes }];
    },
  };
}

/** Where the red block is in a stored photo: share of red pixels in each half. */
async function redHalves(data: Buffer): Promise<{ top: number; bottom: number; left: number; right: number; w: number; h: number }> {
  const { data: px, info } = await sharp(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = { top: 0, bottom: 0, left: 0, right: 0, w: info.width, h: info.height };
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (px[i]! > 180 && px[i + 1]! < 90 && px[i + 2]! < 90) {
        if (y < info.height / 2) out.top++; else out.bottom++;
        if (x < info.width / 2) out.left++; else out.right++;
      }
    }
  }
  return out;
}

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

const plainFront = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#808080" } }).jpeg().toBuffer();
/** A one card scan always has a front; a lone back photo gets a plain front beside it (photo 0), so the back is photo 1. */
async function scanOf(photos: { role: "front" | "back"; data: Buffer }[]) {
  const all = photos[0]!.role === "back" ? [{ role: "front" as const, data: await plainFront() }, ...photos] : photos;
  const { scanId } = await createScan({ mode: "single", photos: all }, db);
  return scanId;
}
const rows = () => db.select().from(images).all();
const backRow = () => rows().find((r) => r.role === "back")!;

// Card on a landscape table photo, lying sideways: wider than tall.
const SIDEWAYS = { photoW: 1200, photoH: 900, card: { x: 250, y: 250, w: 700, h: 500 } };
const sidewaysBox = { x: 250 / 1200, y: 250 / 900, w: 700 / 1200, h: 500 / 900 };

describe("planFix", () => {
  const photo = [1200, 900] as const;
  it("cuts only a trusted, card shaped, partial box that holds all the text, with a 3 percent margin", () => {
    const card = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    expect(planFix(fix({ card, cardTrusted: true, lines: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.05 }] }), 1000, 1000)).toBeNull();
    const ok = { x: 250 / 1200, y: 100 / 900, w: 500 / 1200, h: 700 / 900 };
    const plan = planFix(fix({ card: ok, cardTrusted: true, lines: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.05 }] }), ...photo)!;
    expect(plan.turn).toBe(0);
    expect(plan.box!.x).toBeCloseTo(ok.x - 0.03);
    expect(plan.box!.w).toBeCloseTo(ok.w + 0.06);
  });
  it("does not cut when the box is not trusted, too big, too small, the wrong shape, or leaves text out", () => {
    const base = { x: 250 / 1200, y: 100 / 900, w: 500 / 1200, h: 700 / 900 };
    const line = { x: 0.3, y: 0.3, w: 0.1, h: 0.05 };
    expect(planFix(fix({ card: base, cardTrusted: false, lines: [line] }), 1200, 900)).toBeNull();
    expect(planFix(fix({ card: { x: 0.01, y: 0.01, w: 0.97, h: 0.98 }, cardTrusted: true }), 1000, 1000)).toBeNull();
    expect(planFix(fix({ card: { x: 0.4, y: 0.4, w: 0.2, h: 0.28 }, cardTrusted: true }), 1000, 1000)).toBeNull();
    expect(planFix(fix({ card: { x: 0.1, y: 0.1, w: 0.7, h: 0.7 }, cardTrusted: true }), 1000, 1000)).toBeNull();
    expect(planFix(fix({ card: base, cardTrusted: true, lines: [{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }] }), 1200, 900)).toBeNull();
  });
  it("turns only when the direction is trusted, and only the turn when the box is refused", () => {
    expect(planFix(fix({ turn: 90, turnTrusted: false }), 1200, 900)).toBeNull();
    expect(planFix(fix({ turn: 90 }), 1200, 900)).toEqual({ turn: 90, box: null });
  });
});

describe("the fix after a one card scan", () => {
  it("stores a sideways back upright and cut to the card, and keeps the original so it can be restored", async () => {
    // The card's top points left, so a turn of 90 clockwise stands it up.
    const data = await tablePhoto({ ...SIDEWAYS, red: "left" });
    const scanId = await scanOf([{ role: "back", data }]);
    const before = backRow();
    const workBytes = fs.readFileSync(path.join(workDir(), before.workFile!));
    await processScan(scanId, { db, recognizer: fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90, card: sidewaysBox, cardTrusted: true, lines: [{ x: 0.3, y: 0.4, w: 0.3, h: 0.1 }] }) }]) });

    expect(db.select().from(scans).get()!.status).toBe("done");
    const after = backRow();
    expect(after.originalFile).toBeTruthy();
    expect(after.height).toBeGreaterThan(after.width);
    // About the card (500 by 700) plus the margin, not the whole table.
    expect(after.width).toBeGreaterThan(500);
    expect(after.width).toBeLessThan(600);
    expect(after.height).toBeGreaterThan(700);
    expect(after.height).toBeLessThan(820);
    const red = await redHalves((await readPhoto(after.file)).data);
    expect(red.top).toBeGreaterThan(0);
    expect(red.bottom).toBe(0);
    // The thumbnail is made from the fixed photo and fits inside 320 px.
    const thumb = await sharp(await fs.promises.readFile(path.join(uploadsDir(), after.thumbFile))).metadata();
    expect(thumb.height).toBeGreaterThan(thumb.width!);
    expect(Math.max(thumb.width!, thumb.height!)).toBe(320);

    // The untouched photo is kept the way every photo is archived (review fix 7): AVIF at the archive
    // edge and quality, not the full size working JPEG, and under a name of its own.
    expect(after.originalFile).toMatch(/\.avif$/);
    expect(sameFamily(after.originalFile!, before.file)).toBe(false);
    const kept = fs.readFileSync(path.join(uploadsDir(), after.originalFile!));
    const keptMeta = await sharp(kept).metadata();
    expect(keptMeta.format).toBe("heif");
    expect(Math.max(keptMeta.width!, keptMeta.height!)).toBeLessThanOrEqual(ARCHIVE_EDGE);
    expect(kept.length).toBeLessThan(workBytes.length);
    // Untouched: still sideways, with the whole table.
    expect({ width: keptMeta.width, height: keptMeta.height }).toEqual({ width: 1200, height: 900 });
    // Back to original, through the same code as the photo tools: the archive copy of the untouched photo.
    const restored = await restorePhoto({ itemId: after.itemId!, imageId: after.id }, db);
    expect(restored.ok).toBe(true);
    const back = backRow();
    expect(back).toMatchObject({ file: after.originalFile, originalFile: null, workFile: null, width: 1200, height: 900 });
    expect((await readPhoto(back.file)).data.equals(kept)).toBe(true);
    // Nothing is waiting for the archiver, and the cleanup keeps what the row uses.
    expect(await removeOrphanPhotos(db, uploadsDir(), new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))).toBe(0);
    expect(fs.existsSync(path.join(uploadsDir(), back.file))).toBe(true);
  });

  it("stands an upside down front up", async () => {
    const data = await tablePhoto({ photoW: 900, photoH: 1200, card: { x: 150, y: 150, w: 600, h: 900 }, red: "bottom" });
    const scanId = await scanOf([{ role: "front", data }]);
    await processScan(scanId, { db, recognizer: fakeWith([{ sourceIndex: 0, role: "front", ...fix({ turn: 180 }) }]) });
    const after = rows()[0]!;
    expect(after.originalFile).toBeTruthy();
    expect({ w: after.width, h: after.height }).toEqual({ w: 900, h: 1200 });
    const red = await redHalves((await readPhoto(after.file)).data);
    expect(red.top).toBeGreaterThan(0);
    expect(red.bottom).toBe(0);
  });

  it("only turns, with the whole photo kept, when the card box is not to be trusted", async () => {
    const cases: [string, Partial<ReadFix>][] = [
      ["not trusted", { card: sidewaysBox, cardTrusted: false }],
      ["all card", { card: { x: 0.01, y: 0.01, w: 0.98, h: 0.98 }, cardTrusted: true }],
      ["not card shaped", { card: { x: 0.1, y: 0.1, w: 0.5, h: 0.7 }, cardTrusted: true }],
      ["text outside", { card: sidewaysBox, cardTrusted: true, lines: [{ x: 0.02, y: 0.02, w: 0.1, h: 0.05 }] }],
    ];
    for (const [, over] of cases) {
      const scanId = await scanOf([{ role: "back", data: await tablePhoto({ ...SIDEWAYS, red: "left" }) }]);
      await processScan(scanId, { db, recognizer: fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90, ...over }) }]) });
      const row = db.select().from(images).where(eq(images.scanId, scanId)).all().find((r) => r.role === "back")!;
      expect({ w: row.width, h: row.height }).toEqual({ w: 900, h: 1200 });
      expect(row.originalFile).toBeTruthy();
    }
  });

  it("offers Trim the photo for a photo the app did not cut, until the owner changes it (review fix 6)", async () => {
    const scanId = await scanOf([{ role: "back", data: await tablePhoto({ ...SIDEWAYS, red: "left" }) }]);
    await processScan(scanId, { db, recognizer: fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90, card: sidewaysBox, cardTrusted: false }) }]) });
    const item = db.select().from(items).get()!;
    const back = backRow();
    const front = rows().find((r) => r.role === "front")!;
    expect(offerTrim(item, back)).toBe(true);
    // The front had no fix at all: nothing is said about it.
    expect(offerTrim(item, front)).toBe(false);
    // Trimmed or turned by the owner since: the size changed, the hint goes.
    expect(offerTrim(item, { ...back, width: back.width - 40 })).toBe(false);
    // A cut the app made: no hint.
    const cut = await scanOf([{ role: "back", data: await tablePhoto({ ...SIDEWAYS, red: "left" }) }]);
    await processScan(cut, { db, recognizer: fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90, card: sidewaysBox, cardTrusted: true, lines: [{ x: 0.3, y: 0.4, w: 0.3, h: 0.1 }] }) }]) });
    const cutItem = db.select().from(items).where(eq(items.scanId, cut)).get()!;
    const cutBack = db.select().from(images).where(eq(images.scanId, cut)).all().find((r) => r.role === "back")!;
    expect(offerTrim(cutItem, cutBack)).toBe(false);
  });

  it("leaves a photo alone when neither the turn nor the box is trusted", async () => {
    const scanId = await scanOf([{ role: "back", data: await tablePhoto({ ...SIDEWAYS, red: "left" }) }]);
    const before = backRow();
    await processScan(scanId, { db, recognizer: fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90, turnTrusted: false, card: sidewaysBox, cardTrusted: false }) }]) });
    expect(db.select().from(scans).get()!.status).toBe("done");
    expect(backRow()).toMatchObject({ file: before.file, workFile: before.workFile, originalFile: null, width: 1200, height: 900 });
  });

  it("never fails the scan when the fix fails, and keeps the photo as it was", async () => {
    const scanId = await scanOf([{ role: "back", data: await tablePhoto({ ...SIDEWAYS, red: "left" }) }]);
    const before = backRow();
    const breaking: Recognizer = {
      name: "fake-model",
      async recognize(req) {
        // The working copy disappears after reading, so the fix cannot be made.
        fs.rmSync(path.join(workDir(), before.workFile!));
        return fakeWith([{ sourceIndex: 1, role: "back", ...fix({ turn: 90 }) }]).recognize(req);
      },
    };
    await processScan(scanId, { db, recognizer: breaking });
    expect(db.select().from(scans).get()!.status).toBe("done");
    expect(backRow()).toMatchObject({ file: before.file, workFile: before.workFile, originalFile: null });
  });
});

describe("many cards: the stored crop is upright", () => {
  it("turns a trusted crop and leaves an untrusted one as cut", async () => {
    const source = await tablePhoto({ ...SIDEWAYS, red: "left" });
    for (const trusted of [true, false]) {
      const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: source }] }, db);
      const recognizer: Recognizer = {
        name: "fake-model",
        async recognize() {
          return [{ ...recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "Test Player", box: sidewaysBox }), fixes: [{ sourceIndex: 0, role: "front", ...fix({ turn: 90, turnTrusted: trusted }) }] }];
        },
      };
      await processScan(scanId, { db, recognizer });
      const crop = db.select().from(images).where(eq(images.scanId, scanId)).all().find((i) => i.role === "crop")!;
      if (trusted) expect(crop.height).toBeGreaterThan(crop.width);
      else expect(crop.width).toBeGreaterThan(crop.height);
      const red = await redHalves((await readPhoto(crop.file)).data);
      if (trusted) expect(red.bottom).toBe(0);
    }
  });
});

describe("many cards: each cut-out as a one card photo (review fix 3)", () => {
  it("cuts along the card's own outline (no neighbour shows) and stands a card lying on its side up", async () => {
    // A card lying sideways (top to the left), and a blue card right beside it.
    const c = { x: 250, y: 250, w: 700, h: 500 };
    const base = await tablePhoto({ ...SIDEWAYS, red: "left" });
    const source = await sharp(base).composite([{ input: { create: { width: 1200, height: 60, channels: 3, background: "#0000ff" } }, top: 190, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
    const { scanId } = await createScan({ mode: "multi", photos: [{ role: "source", data: source }] }, db);
    // A tilted outline inside the box: the corners of the box are painted plain.
    const outline: [number, number][] = [[(c.x + 30) / 1200, c.y / 900], [(c.x + c.w) / 1200, (c.y + 20) / 900], [(c.x + c.w - 30) / 1200, (c.y + c.h) / 900], [c.x / 1200, (c.y + c.h - 20) / 900]];
    const recognizer: Recognizer = {
      name: "fake-model",
      async recognize() {
        return [{
          ...recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "Test Player", box: sidewaysBox }),
          // The text leans to a quarter turn without settling it.
          fixes: [{ sourceIndex: 0, role: "front", ...fix({ turn: 90, turnTrusted: false }) }],
          cuts: { front: { box: sidewaysBox, outline, tilt: 0 } },
        }];
      },
    };
    await processScan(scanId, { db, recognizer });
    const crop = db.select().from(images).where(eq(images.scanId, scanId)).all().find((i) => i.role === "crop")!;
    expect(crop.height).toBeGreaterThan(crop.width);
    // Exactly the card's box, no margin of the table and the card beside it.
    expect(crop.width).toBeLessThanOrEqual(500);
    const { data: px, info } = await sharp((await readPhoto(crop.file)).data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let blue = 0;
    for (let i = 0; i < px.length; i += 3) if (px[i + 2]! > 180 && px[i]! < 80 && px[i + 1]! < 80) blue++;
    expect(blue).toBe(0);
    expect(info.height).toBeGreaterThan(info.width);
    const red = await redHalves((await readPhoto(crop.file)).data);
    expect(red.top).toBeGreaterThan(0);
    expect(red.bottom).toBe(0);
  });

  it("planFix: a quarter turn the text leans to is made when the card lies on its side", () => {
    const lying = { x: 0.1, y: 0.2, w: 0.8, h: 0.6 };
    expect(planFix(fix({ turn: 270, turnTrusted: false, card: lying, cardTrusted: true }), 1000, 900)?.turn).toBe(270);
    // Standing card, or a box not trusted: no turn.
    expect(planFix(fix({ turn: 270, turnTrusted: false, card: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 }, cardTrusted: true }), 1000, 900)?.turn ?? 0).toBe(0);
    expect(planFix(fix({ turn: 270, turnTrusted: false, card: lying, cardTrusted: false }), 1000, 900)).toBeNull();
  });
});
