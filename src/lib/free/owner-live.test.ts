import { describe, expect, it } from "vitest";
import { LIVE_SINGLES, liveManyPhotos, liveSinglePhotos, recordedLiveMany, recordedLiveSingle } from "../../../tests/helpers/ocr-fixture";
import { checkLiveMany, checkLiveSingle } from "../../../tests/helpers/owner-live";
import { looksLikeBack, repeatedSides, type SideRead } from "./multi";
import type { OcrResult, ReadOptions, TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The owner's live scans of 2026-11-25 (owner scans 8 to 12), replayed from
 * the real reader's recorded output (tests/fixtures/real-cards/live*.ocr.json,
 * made by owner-live.integration.test.ts with UPDATE_OCR=1). No Python, no
 * network, no catalog, no Wikidata.
 */

/** Gives the recorded reads in the order they were made, asking backIf as the real reader does. */
function replay(reads: (OcrResult | null)[]): TextReader {
  let n = 0;
  return {
    async read(_image: Buffer, options?: ReadOptions): Promise<OcrResult> {
      const r = reads[n++] ?? { text: "", lines: [], confidence: 0 };
      options?.backIf?.(r);
      return r;
    },
  };
}

describe("the owner's live one card scans, recorded", () => {
  for (const id of LIVE_SINGLES) {
    it(`${id}: read as expected`, async () => {
      const { front, back } = recordedLiveSingle(id);
      const items = await new FreeRecognizer({ reader: replay([front, back]), lookup: async () => null })
        .recognize({ mode: "single", photos: await liveSinglePhotos(id) });
      checkLiveSingle(id, items);
    });
  }
});

describe("the owner's many-cards scan 8, recorded", () => {
  const rec = recordedLiveMany();

  it("finds the three cards in each photo, and nothing else (no notebook, no keyboard)", () => {
    expect(rec.shapes.map((s) => s.length)).toEqual([3, 3, 3]);
  });

  it("knows the same side photographed twice: the fronts of Milacki and Mills, the back of Hardaway", () => {
    let k = 0;
    const sides: SideRead[] = rec.shapes.flatMap((s, photo) => s.map(() => {
      const text = rec.reads[k++];
      return { photo, text, back: looksLikeBack(text) };
    }));
    const again = repeatedSides(sides);
    expect(again.size).toBe(3);
    for (const [dropped, kept] of again) {
      expect(sides[dropped].back).toBe(sides[kept].back);
      expect(sides[dropped].photo).not.toBe(sides[kept].photo);
    }
  });

  it("gives exactly three items, each with its front and back and nothing wrong", async () => {
    const photos = await liveManyPhotos();
    const items = await new FreeRecognizer({
      reader: replay(rec.reads),
      findShapes: async (image) => rec.shapes[photos.findIndex((p) => p.data === image)] ?? [],
      lookup: async () => null,
    }).recognize({ mode: "multi", photos });
    checkLiveMany(items);
  });
});
