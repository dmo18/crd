import fs from "node:fs";
import { afterAll, describe, it } from "vitest";
import {
  LIVE_MANY_RECORDING, LIVE_SINGLES, liveManyPhotos, liveSingleFiles, liveSinglePhotos, updatingOcr, type MultiRecording, type RecordedOcr,
} from "../../../tests/helpers/ocr-fixture";
import { checkLiveMany, checkLiveSingle } from "../../../tests/helpers/owner-live";
import { findCardShapes, type CardShape } from "./find-cards";
import { createTextReader, pythonEngine, readerSettings, type OcrResult, type TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The owner's live scans of 2026-11-25 (owner scans 8 to 12) with the real
 * text reader. Skipped unless OCR_TEST_PYTHON points at a Python with
 * rapidocr, as in ocr.integration.test.ts:
 *
 *   OCR_TEST_PYTHON=/path/to/venv/bin/python npx vitest run src/lib/free/owner-live.integration.test.ts
 *
 * UPDATE_OCR=1 also records the reads (and the cards found in scan 8) for
 * owner-live.test.ts. No network: no catalog, no Wikidata.
 */
const PYTHON = process.env.OCR_TEST_PYTHON?.trim();
const engine = PYTHON ? pythonEngine({ ...readerSettings(), python: PYTHON }) : null;
const inner = engine ? createTextReader(engine) : null;

afterAll(async () => {
  await engine?.close();
});

function recording(): { reader: TextReader; reads: OcrResult[] } {
  const reads: OcrResult[] = [];
  return {
    reads,
    reader: {
      async read(image, options) {
        const read = await inner!.read(image, options);
        reads.push(read);
        return read;
      },
    },
  };
}

describe.skipIf(!inner)("real text reader: the owner's live scans of 2026-11-25", () => {
  for (const id of LIVE_SINGLES) {
    it(`${id}: one card, read as expected`, async () => {
      const { reader, reads } = recording();
      const items = await new FreeRecognizer({ reader, lookup: async () => null }).recognize({ mode: "single", photos: await liveSinglePhotos(id) });
      if (updatingOcr) {
        const rec: RecordedOcr = { front: reads[0], back: reads[1] };
        fs.writeFileSync(liveSingleFiles(id).recording, `${JSON.stringify(rec, null, 1)}\n`);
      }
      checkLiveSingle(id, items);
    }, 180_000);
  }

  it("scan 8: three cards in three photos, fronts and backs mixed, give three items", async () => {
    const { reader, reads } = recording();
    const shapes: CardShape[][] = [];
    const items = await new FreeRecognizer({
      reader,
      findShapes: async (image) => {
        const found = await findCardShapes(image);
        shapes.push(found);
        return found;
      },
      lookup: async () => null,
    }).recognize({ mode: "multi", photos: await liveManyPhotos() });
    if (updatingOcr) {
      const rec: MultiRecording = { shapes, reads };
      fs.writeFileSync(LIVE_MANY_RECORDING, `${JSON.stringify(rec, null, 1)}\n`);
    }
    checkLiveMany(items);
  }, 600_000);
});
