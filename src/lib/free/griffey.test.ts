import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecognizedItem } from "@/lib/recognition/types";
import { buildTitle } from "@/lib/title";
import { fixturePhotos, GRIFFEY, recordedOcr } from "../../../tests/helpers/ocr-fixture";
import { closeTextReader } from "./ocr";
import { parseCardText } from "./parse";
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
 *
 * The real reader does not return the same letters on every run (the name
 * can come back as "Criffey"), so the end to end part checks only the fields
 * that are stable. The exact name words are checked on the recorded text.
 */

/** Words from the bio, the stat table and misread scraps that must never end up in a name. */
const NOT_NAME = /graduated|moeller|cincinnati|high school|played|football|baseball|player|year|bellingham|bernardino|vermont|tug|atau/i;

let item: RecognizedItem;
let title: string;

beforeAll(async () => {
  const recognizer = new FreeRecognizer({ lookup: async () => null });
  const started = Date.now();
  [item] = await recognizer.recognize({ mode: "single", photos: fixturePhotos(GRIFFEY) });
  console.log(`Griffey scan took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  title = buildTitle(item);
}, 120_000);

afterAll(async () => {
  await closeTextReader();
});

describe("1990 Topps Ken Griffey Jr., read end to end", () => {
  it("reads the sport", () => expect(item.sport).toBe("baseball"));
  it("reads the year from the stat table", () => expect(item.year).toBe(1990));
  it("reads the team", () => expect(item.team ?? "").toContain("Mariners"));
  it("never reads a wrong card number", () => expect([null, "336"]).toContain(item.cardNumber));
  it("takes no name from a sentence", () => {
    expect(title).not.toMatch(NOT_NAME);
    expect(item.player ?? "").not.toMatch(NOT_NAME);
  });
  // Not reached with these photos: TOPPS is printed only as the script logo
  // and in tiny print by the right edge, and neither is read. Confidence
  // needs the brand to reach 0.5. Open question for the owner, see STATUS.md.
  it.todo("reads the brand Topps");
  it.todo("is sure enough to show, even if it waits in Review (confidence 0.5)");
  it.todo("reads the full name Ken Griffey Jr. every time (Milestone 10, card catalog)");
  it.todo("fills the card number 336 (Milestone 10, card catalog)");
});

describe("1990 Topps Ken Griffey Jr., parsing the recorded text", () => {
  const { front, back } = recordedOcr(GRIFFEY);
  const parsed = parseCardText(front, back);

  it("gives only Griffey spellings as player candidates, no sentence names", () => {
    expect(parsed.playerCandidates.length).toBeGreaterThan(0);
    for (const name of parsed.playerCandidates) {
      expect(name).toMatch(/^(?:Ken )?Griffey/);
      expect(name).not.toMatch(/Ken Graduated|Moeller Cincinnati|Tug Atau Le/i);
    }
  });

  it("keeps Ken from the bio only as a first name hint", () => expect(parsed.firstNameHint).toBe("Ken"));

  it("reads team, year, sport and position", () => {
    expect(parsed.team ?? "").toContain("Mariners");
    expect(parsed.year).toBe(1990);
    expect(parsed.sport).toBe("baseball");
    expect(parsed.position).toBe("OF");
  });
});
