import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRecognizer } from "./index";
import { SampleRecognizer, hintYear } from "./sample";
import {
  REVIEW_THRESHOLD,
  RecognitionError,
  recognizedItemSchema,
  type Box,
  type RecognitionMode,
  type RecognitionPhoto,
  type RecognizedItem,
} from "./types";

function photo(seed: string, role: RecognitionPhoto["role"] = "front"): RecognitionPhoto {
  return { role, data: createHash("sha256").update(seed).digest(), width: 1200, height: 1600 };
}

const sample = new SampleRecognizer();
const run = (mode: RecognitionMode, photos: RecognitionPhoto[], hint?: string) => sample.recognize({ mode, photos, hint });

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function expectValid(items: RecognizedItem[]) {
  for (const item of items) {
    expect(recognizedItemSchema.safeParse(item).success).toBe(true);
    expect(item.estimate?.basis?.startsWith("Sample data, not a real estimate.")).toBe(true);
  }
}

describe("SampleRecognizer", () => {
  it("is named sample", () => {
    expect(sample.name).toBe("sample");
  });

  it("gives the same result for the same photo and mode", async () => {
    for (const mode of ["single", "multi", "sealed", "bulk"] as const) {
      const role = mode === "single" ? "front" : "source";
      const a = await run(mode, [photo("same", role)]);
      const b = await run(mode, [photo("same", role)]);
      expect(a).toEqual(b);
    }
  });

  it("returns one valid card in single mode", async () => {
    const items = await run("single", [photo("one"), photo("one-back", "back")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("card");
    expect(items[0].box).toBeNull();
    expect(items[0].sourceIndex).toBe(0);
    expectValid(items);
  });

  it("puts 4 to 9 distinct cards per source photo in a tidy grid", async () => {
    const photos = [photo("ignored-front", "front"), photo("table-1", "source"), photo("table-2", "source")];
    const items = await run("multi", photos);
    expectValid(items);
    for (const index of [1, 2]) {
      const mine = items.filter((i) => i.sourceIndex === index);
      expect(mine.length).toBeGreaterThanOrEqual(4);
      expect(mine.length).toBeLessThanOrEqual(9);
      expect(new Set(mine.map((i) => `${i.year} ${i.brand} ${i.cardNumber} ${i.player}`)).size).toBe(mine.length);
      const boxes = mine.map((i) => i.box);
      for (const box of boxes) {
        expect(box).not.toBeNull();
        if (!box) continue;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(1);
        expect(box.y + box.h).toBeLessThanOrEqual(1);
      }
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          expect(overlaps(boxes[a] as Box, boxes[b] as Box)).toBe(false);
        }
      }
    }
    expect(items.some((i) => i.sourceIndex === 0)).toBe(false);
  });

  it("covers every count from 4 to 9 across many photos", async () => {
    const counts = new Set<number>();
    for (let i = 0; i < 60; i++) counts.add((await run("multi", [photo(`grid-${i}`, "source")])).length);
    expect([...counts].sort()).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("returns a sealed product with a pull list", async () => {
    const items = await run("sealed", [photo("box", "source")]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("sealed");
    expect(item.productType).not.toBeNull();
    expect(item.sealState).not.toBeNull();
    expect(item.pullList.length).toBeGreaterThan(0);
    expect(item.estimate).not.toBeNull();
    expectValid(items);
  });

  it("returns a bulk lot with 5 to 8 cards to pull", async () => {
    for (let i = 0; i < 20; i++) {
      const items = await run("bulk", [photo(`lot-${i}`, "source")]);
      expect(items).toHaveLength(1);
      const [item] = items;
      expect(item.kind).toBe("bulk");
      expect(item.estCount).toBeGreaterThan(0);
      expect(item.containerType).toBeTruthy();
      expect(item.year).not.toBeNull();
      expect(item.yearEnd).not.toBeNull();
      expect(item.brand ?? item.description).toBeTruthy();
      expect(item.pullList.length).toBeGreaterThanOrEqual(5);
      expect(item.pullList.length).toBeLessThanOrEqual(8);
      expectValid(items);
    }
  });

  it("sends a meaningful share of singles to review", async () => {
    let low = 0;
    for (let i = 0; i < 40; i++) {
      const [item] = await run("single", [photo(`card-${i}`)]);
      if (item.confidence < REVIEW_THRESHOLD) low++;
      else expect(item.confidence).toBeGreaterThanOrEqual(0.8);
      expect(item.confidence).toBeLessThanOrEqual(0.98);
    }
    expect(low).toBeGreaterThanOrEqual(4);
    expect(low).toBeLessThanOrEqual(20);
  });

  it("prefers cards from a year named in the hint", async () => {
    for (let i = 0; i < 10; i++) {
      const [card] = await run("single", [photo(`hinted-${i}`)], "these are 1989 cards");
      expect(card.year).toBe(1989);
    }
    const [sealed] = await run("sealed", [photo("hinted-box", "source")], "1991 football");
    expect(sealed.year).toBe(1991);
    const [lot] = await run("bulk", [photo("hinted-lot", "source")], "box of 1987 Topps");
    expect(lot.year).toBeLessThanOrEqual(1987);
    expect(lot.yearEnd).toBeGreaterThanOrEqual(1987);
  });

  it("reads a year from a hint only within range", () => {
    expect(hintYear("1989 Topps")).toBe(1989);
    expect(hintYear("card 12345 from 1949 or 2031")).toBeNull();
    expect(hintYear(null)).toBeNull();
  });

  it("rejects a scan with no photos", async () => {
    await expect(run("single", [])).rejects.toBeInstanceOf(RecognitionError);
  });
});

describe("SampleRecognizer rookie evidence", () => {
  it("passes its own key list answer explicitly, so a rookie card is a key list hit and others are not", async () => {
    const items = await run("multi", [photo("evidence-seed", "source")]);
    for (const item of items) {
      if (item.kind !== "card") continue;
      expect(item.evidence?.keyCard === undefined).toBe(!item.isRookie);
      expect(item.evidence?.serial).toBeUndefined();
    }
    expect(items.some((i) => i.evidence?.keyCard)).toBe(true);
  });
});

describe("getRecognizer", () => {
  it("returns the sample recognizer under test settings", () => {
    const r = getRecognizer();
    expect(r).toBeInstanceOf(SampleRecognizer);
    expect(r.name).toBe("sample");
  });
});
