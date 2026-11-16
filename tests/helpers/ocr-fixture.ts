import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { RecognitionPhoto } from "@/lib/recognition/types";
import type { OcrResult, TextReader } from "@/lib/free/ocr";

/**
 * Card photo fixtures and their recorded text. The recording lets parsing
 * tests run fast and exactly on what the real reader returned. To record it
 * again after a change to the reader, run the real reader test with UPDATE_OCR=1
 * (it needs a Python with rapidocr, see ocr/README.txt):
 *   UPDATE_OCR=1 OCR_TEST_PYTHON=/path/to/python npx vitest run src/lib/free/ocr.integration.test.ts
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "cards");

export type CardFixture = { name: string; front: string; back: string; recording: string; frontSize: [number, number]; backSize: [number, number] };
export type RecordedOcr = { front: OcrResult; back: OcrResult };

export const GRIFFEY: CardFixture = {
  name: "griffey-1990-topps",
  front: path.join(DIR, "griffey-1990-topps-front.jpg"),
  back: path.join(DIR, "griffey-1990-topps-back.jpg"),
  recording: path.join(DIR, "griffey-1990-topps.ocr.json"),
  frontSize: [554, 1200],
  backSize: [1200, 554],
};

export const updatingOcr = process.env.UPDATE_OCR === "1";

export function fixturePhotos(card: CardFixture): RecognitionPhoto[] {
  return [
    { role: "front", data: fs.readFileSync(card.front), width: card.frontSize[0], height: card.frontSize[1] },
    { role: "back", data: fs.readFileSync(card.back), width: card.backSize[0], height: card.backSize[1] },
  ];
}

/** Reads both sides with the given reader and, with UPDATE_OCR=1, writes the recording. */
export async function readFixture(card: CardFixture, reader: TextReader): Promise<RecordedOcr> {
  const front = await reader.read(fs.readFileSync(card.front));
  const back = await reader.read(fs.readFileSync(card.back), { back: true });
  const result = { front, back };
  if (updatingOcr) fs.writeFileSync(card.recording, `${JSON.stringify(result, null, 1)}\n`);
  return result;
}

/** The recorded text of both sides, as the real reader returned it. */
export function recordedOcr(card: CardFixture): RecordedOcr {
  return JSON.parse(fs.readFileSync(card.recording, "utf8")) as RecordedOcr;
}

const REAL_DIR = path.join(process.cwd(), "tests", "fixtures", "real-cards");

/** The owner's four real cards (answers in tests/fixtures/real-cards/answers.json). */
export const REAL_CARDS = ["griffey", "hardaway", "milacki", "mills"] as const;
export type RealCard = (typeof REAL_CARDS)[number];

export function realCardFiles(id: RealCard) {
  return {
    front: path.join(REAL_DIR, `${id}-front.avif`),
    back: path.join(REAL_DIR, `${id}-back.avif`),
    recording: path.join(REAL_DIR, `${id}.ocr.json`),
  };
}

/** A photo as the reading bench passes it on: turned upright and saved as JPEG (quality 90). */
async function asUploaded(file: string): Promise<Buffer> {
  return sharp(fs.readFileSync(file)).rotate().jpeg({ quality: 90 }).toBuffer();
}

/** Reads a real card's two photos as the bench and recognizer do and, with UPDATE_OCR=1, writes the recording. */
export async function readRealCard(id: RealCard, reader: TextReader): Promise<RecordedOcr> {
  const files = realCardFiles(id);
  const front = await reader.read(await asUploaded(files.front));
  const back = await reader.read(await asUploaded(files.back), { back: true });
  const result = { front, back };
  if (updatingOcr) fs.writeFileSync(files.recording, `${JSON.stringify(result, null, 1)}\n`);
  return result;
}

/** The recorded reader output for one of the owner's real cards. */
export function recordedRealCard(id: RealCard): RecordedOcr {
  return JSON.parse(fs.readFileSync(realCardFiles(id).recording, "utf8")) as RecordedOcr;
}
