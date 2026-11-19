import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { MULTI_RECORDING, multiPhotos, updatingOcr, type MultiRecording } from "../../../tests/helpers/ocr-fixture";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { findCardShapes } from "./find-cards";
import { createTextReader, pythonEngine, readerSettings, type OcrResult, type TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The owner's many-cards try with the real text reader (12R.7). Skipped
 * unless OCR_TEST_PYTHON points at a Python with rapidocr, as in
 * ocr.integration.test.ts:
 *
 *   OCR_TEST_PYTHON=/path/to/venv/bin/python npx vitest run src/lib/free/multi.integration.test.ts
 *
 * UPDATE_OCR=1 also records the found cards and the reads for multi.test.ts.
 */
const PYTHON = process.env.OCR_TEST_PYTHON?.trim();
const engine = PYTHON ? pythonEngine({ ...readerSettings(), python: PYTHON }) : null;
const inner = engine ? createTextReader(engine) : null;

afterAll(async () => {
  await engine?.close();
});

describe.skipIf(!inner)("real text reader: two cards, fronts in one photo and backs in another", () => {
  it(
    "gives exactly two cards, each with its front and back, nothing wrong",
    async () => {
      const photos = await multiPhotos();
      const reads: { seconds: number; read: OcrResult }[] = [];
      const reader: TextReader = {
        async read(image, options) {
          const t = Date.now();
          const read = await inner!.read(image, options);
          reads.push({ seconds: (Date.now() - t) / 1000, read });
          return read;
        },
      };
      const started = Date.now();
      const items = await new FreeRecognizer({ reader, lookup: async () => null }).recognize({ mode: "multi", photos });
      const seconds = (Date.now() - started) / 1000;
      console.log(`many cards: ${seconds.toFixed(1)} s for ${reads.length} card sides (${reads.map((r) => `${r.seconds.toFixed(1)} s`).join(", ")})`);
      if (updatingOcr) {
        const shapes = [];
        for (const p of photos) shapes.push(await findCardShapes(p.data));
        const recording: MultiRecording = { shapes, reads: reads.map((r) => r.read) };
        fs.writeFileSync(MULTI_RECORDING, `${JSON.stringify(recording, null, 1)}\n`);
      }

      expect(items).toHaveLength(2);
      const mills = items.find((i) => i.player === "Billy Mills");
      const hardaway = items.find((i) => i.player === "Tim Hardaway");
      expect(mills).toBeDefined();
      expect(hardaway).toBeDefined();
      // Mills: the copyright line (1991 Impel) is too small to read in this
      // photo, so year and brand may stay blank, never wrong.
      expect(mills).toMatchObject({ cardNumber: "24", sport: "other", team: null });
      expect([null, 1991]).toContain(mills!.year);
      expect([null, "Impel"]).toContain(mills!.brand);
      expect(hardaway).toMatchObject({ year: 1993, brand: "Fleer", cardNumber: "65", sport: "basketball" });
      expect([null, "Golden State Warriors"]).toContain(hardaway!.team);
      for (const card of [mills!, hardaway!]) {
        expect([null, "Ultra", "U.S. Olympic Cards Hall of Fame"]).toContain(card.setName);
        // Each front (first photo) carries its back (second photo).
        expect(card.sourceIndex).toBe(0);
        expect(card.backPhoto?.sourceIndex).toBe(1);
        expect(card.confidence).toBeLessThan(REVIEW_THRESHOLD);
        expect(card.notes).not.toContain("Only one side");
      }
      // Each card was read on its own: no text of the other card in its read.
      const text = reads.map((r) => r.read.text.toUpperCase());
      expect(text.filter((t) => t.includes("HARDAWAY") || t.includes("FLEER")).every((t) => !t.includes("MILLS"))).toBe(true);
      // Aim: about 25 s a card on a quiet server (measured 18 s). The check
      // only guards against a big slow down, since other work on the server
      // can double the time.
      expect(seconds / items.length).toBeLessThan(60);
    },
    300_000,
  );
});
