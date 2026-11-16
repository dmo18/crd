import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecognizedItem } from "@/lib/recognition/types";
import { fixturePhotos, GRIFFEY } from "../../../tests/helpers/ocr-fixture";
import { closeTextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The 1990 Topps #336 Ken Griffey Jr. card the free reader first failed on,
 * read end to end from the owner's two photos with the real text reader.
 * No network: the Wikidata lookup is faked to find nothing.
 *
 * Target for Milestone 9 (docs/ROADMAP.md section 4): sport, year, brand,
 * team, and no wrong names. The full name "Ken Griffey Jr." and the number
 * 336 come with the card catalog in Milestone 10. The photo of the back is
 * cropped so the number is cut off, so the number is empty or 336, never
 * another number.
 */

let item: RecognizedItem;

beforeAll(async () => {
  const recognizer = new FreeRecognizer({ lookup: async () => null });
  const started = Date.now();
  [item] = await recognizer.recognize({ mode: "single", photos: fixturePhotos(GRIFFEY) });
  console.log(`Griffey scan took ${((Date.now() - started) / 1000).toFixed(1)} s`);
}, 120_000);

afterAll(async () => {
  await closeTextReader();
});

describe("1990 Topps Ken Griffey Jr., read end to end", () => {
  it("reads the sport", () => expect(item.sport).toBe("baseball"));
  it("never reads a wrong card number", () => expect([null, "336"]).toContain(item.cardNumber));
  it.todo("reads the year (task 9.11, stat table rule)");
  it.todo("reads the team (task 9.11, team rule)");
  it.todo("takes no name from a sentence (task 9.11)");
  it.todo("reads the brand Topps");
  it.todo("is sure enough to show, even if it waits in Review");
  it.todo("reads the full name Ken Griffey Jr. (Milestone 10, card catalog)");
  it.todo("fills the card number 336 (Milestone 10, card catalog)");
});
