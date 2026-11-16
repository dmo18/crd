import fs from "node:fs";
import path from "node:path";
import type { RecognitionPhoto } from "@/lib/recognition/types";
import type { OcrResult, TextReader } from "@/lib/free/ocr";

/**
 * Card photo fixtures and their recorded text. The recording lets parsing
 * tests run fast and exactly on what the real reader returned. To record it
 * again after a change to the reader, run the tests with UPDATE_OCR=1:
 *   UPDATE_OCR=1 npx vitest run src/lib/free/ocr.test.ts
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
  const back = await reader.read(fs.readFileSync(card.back));
  const result = { front, back };
  if (updatingOcr) fs.writeFileSync(card.recording, `${JSON.stringify(result, null, 1)}\n`);
  return result;
}

/** The recorded text of both sides, as the real reader returned it. */
export function recordedOcr(card: CardFixture): RecordedOcr {
  return JSON.parse(fs.readFileSync(card.recording, "utf8")) as RecordedOcr;
}
