import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { images } from "@/db/schema";
import { readPhoto } from "@/lib/images/store";
import { createScan } from "@/lib/scans/create";
import { processScan } from "@/lib/scans/process";
import { createTextReader, pythonEngine, readerSettings } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The picture fix with the real text reader (S1b). Skipped unless
 * OCR_TEST_PYTHON points at a Python with rapidocr:
 *
 *   OCR_TEST_PYTHON=/path/to/venv/bin/python npx vitest run src/lib/free/photo-fix.integration.test.ts
 *
 * OCR_TEST_OUT=/some/folder also writes the stored photos there to look at.
 */
const PYTHON = process.env.OCR_TEST_PYTHON?.trim();
const OUT = process.env.OCR_TEST_OUT?.trim();
const engine = PYTHON ? pythonEngine({ ...readerSettings(), python: PYTHON }) : null;
const reader = engine ? createTextReader(engine) : null;
const REAL = path.join(process.cwd(), "tests", "fixtures", "real-cards");

afterAll(async () => {
  await engine?.close();
});

describe.skipIf(!reader)("real reader: the stored photos are upright and cut to the card", () => {
  it(
    "stands the sideways back of the angled Milacki card up and cuts both photos to the card; a re-read needs no turn",
    async () => {
      const db = createDb(":memory:");
      const front = fs.readFileSync(path.join(REAL, "milacki-angled-front.jpg"));
      const back = fs.readFileSync(path.join(REAL, "milacki-angled-back.jpg"));
      const { scanId } = await createScan({ mode: "single", photos: [{ role: "front", data: front }, { role: "back", data: back }] }, db);
      const before = db.select().from(images).all();
      const backBefore = before.find((r) => r.role === "back")!;
      await processScan(scanId, { db, recognizer: new FreeRecognizer({ reader: reader!, lookup: async () => null }) });

      const rows = db.select().from(images).all();
      const backRow = rows.find((r) => r.role === "back")!;
      const frontRow = rows.find((r) => r.role === "front")!;
      console.log(`back ${backBefore.width}x${backBefore.height} -> ${backRow.width}x${backRow.height}; front ${before[0]!.width}x${before[0]!.height} -> ${frontRow.width}x${frontRow.height}`);
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, "back-stored.jpg"), await sharp((await readPhoto(backRow.file)).data).jpeg().toBuffer());
        fs.writeFileSync(path.join(OUT, "front-stored.jpg"), await sharp((await readPhoto(frontRow.file)).data).jpeg().toBuffer());
        fs.writeFileSync(path.join(OUT, "back-thumb.jpg"), await sharp((await readPhoto(backRow.thumbFile)).data).jpeg().toBuffer());
      }

      // The photo is tall but this card's back is a wide design with its text
      // sideways in the photo: turned, it is wider than tall, and cut to the card.
      expect(backBefore.height).toBeGreaterThan(backBefore.width);
      expect(backRow.width).toBeGreaterThan(backRow.height);
      expect(backRow.width * backRow.height).toBeLessThan(0.7 * backBefore.width * backBefore.height);
      expect(backRow.originalFile).toBeTruthy();
      // The front was upright: only cut to the card (taller than wide, still).
      expect(frontRow.height).toBeGreaterThan(frontRow.width);
      expect(frontRow.width * frontRow.height).toBeLessThan(0.7 * before[0]!.width * before[0]!.height);

      // A re-read of the stored photo finds the name with no turn needed.
      const stored = await sharp((await readPhoto(backRow.file)).data).jpeg({ quality: 92 }).toBuffer();
      const again = await reader!.read(stored, { back: true });
      expect(again.text.toUpperCase()).toContain("MILACKI");
      expect(again.fix?.turn ?? 0).toBe(0);
    },
    300_000,
  );
});
