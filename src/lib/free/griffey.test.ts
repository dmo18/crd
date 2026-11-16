import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate } from "@/lib/catalog/match";
import type { RecognitionPhoto, RecognizedItem } from "@/lib/recognition/types";
import { buildTitle } from "@/lib/title";
import { FakeCatalog, GRIFFEY_SEARCH, RECORDED } from "../../../tests/helpers/fake-catalog";
import { fixturePhotos, GRIFFEY, recordedOcr } from "../../../tests/helpers/ocr-fixture";
import { createTextReader, pythonEngine, readerSettings, type TextReader } from "./ocr";
import { parseCardText } from "./parse";
import { FreeRecognizer } from "./recognizer";
import type { PlayerFacts } from "./wikidata";

/**
 * The 1990 Topps #336 Ken Griffey Jr. card the free reader first failed on,
 * from the owner's two photos. No network anywhere.
 *
 * Target (docs/PLAN.md, Milestone 10, "Part C finished through the catalog",
 * with automatic filling off since the fifth 10.6 review): sport baseball,
 * year 1990, team Mariners, no sentence words in the title or player, card
 * number empty or 336, and 1990 Topps #336 Ken Griffey Jr. FIRST in the
 * catalog suggestions in Review (a suggestion, not filled). The brand Topps
 * is not read from these photos (script logo, tiny copyright print), so the
 * brand is Topps or empty.
 *
 * Recorded again in 12R.3 with the RapidOCR reader (the old recording was
 * tesseract text): it reads "89 MARINERS" exactly in the stat table with
 * baseball stat headers, so the team is read from the card. Before, the
 * reader saw only "89 MARMNERS", a hint that Wikidata had to confirm.
 */

/** Words from the bio, the stat table and misread scraps that must never end up in a name. */
const NOT_NAME = /graduated|moeller|cincinnati|high school|played|football|baseball|player|year|bellingham|bernardino|vermont|tug|atau/i;

/** The Wikidata facts row for Ken Griffey Jr. (faked here; the online lookup is never called in tests). */
const GRIFFEY_FACTS: PlayerFacts = {
  name: "Ken Griffey Jr.", wikidataId: "Q737296", description: "American baseball player (born 1969)", sports: ["baseball"],
  teams: ["Seattle Mariners", "Cincinnati Reds", "Chicago White Sox"], careerStart: 1989, careerEnd: 2010, hallOfFame: true, birthYear: 1969,
};

/** The recorded text of both photos, served by the photo's first byte (1 front, 2 back). */
function recordedReader(): TextReader {
  const { front, back } = recordedOcr(GRIFFEY);
  return { read: async (image: Buffer) => (image[0] === 1 ? front : back) };
}
const PHOTOS: RecognitionPhoto[] = [
  { role: "front", data: Buffer.from([1]), width: 554, height: 1200 },
  { role: "back", data: Buffer.from([2]), width: 1200, height: 554 },
];

/**
 * The catalog from the recorded answers. No brand is read, so the look up
 * searches "1990 Ken Griffey Jr."; it is answered with the recorded answer
 * to "1990 Topps Ken Griffey Jr.", the closest recording we hold.
 */
function griffeyCatalog() {
  return new FakeCatalog({ searches: { ...RECORDED, "1990 ken griffey jr.": GRIFFEY_SEARCH } });
}

function checkStableFields(item: RecognizedItem) {
  expect(item.sport).toBe("baseball");
  expect(item.year).toBe(1990);
  expect([null, "336"]).toContain(item.cardNumber);
  expect([null, "Topps"]).toContain(item.brand);
  expect(buildTitle(item)).not.toMatch(NOT_NAME);
  expect(item.player ?? "").not.toMatch(NOT_NAME);
}

describe("1990 Topps Ken Griffey Jr., recorded text, catalog and facts, end to end", () => {
  let item: RecognizedItem;
  let lookups: string[];
  let catalog: FakeCatalog;

  beforeAll(async () => {
    lookups = [];
    catalog = griffeyCatalog();
    const r = new FreeRecognizer({
      reader: recordedReader(),
      lookup: async (name) => { lookups.push(name); return name === "Ken Griffey Jr." ? GRIFFEY_FACTS : null; },
      catalog,
    });
    [item] = await r.recognize({ mode: "single", photos: PHOTOS });
  });

  it("reads sport, year, number, brand and no sentence words", () => checkStableFields(item));
  it("reads the full name Ken Griffey Jr.", () => expect(item.player).toBe("Ken Griffey Jr."));
  it("has the team Mariners, read from the card", () => {
    expect(item.team).toBe("Seattle Mariners");
    expect(item.notes).toMatch(/Read team: Seattle Mariners/);
    expect(lookups).toEqual(["Ken Griffey Jr."]);
  });
  it("puts 1990 Topps #336 Ken Griffey Jr. first in the catalog suggestions, without filling it", () => {
    expect(item.catalog?.status).toBe("candidates");
    const first = (item.catalog as { candidates: Candidate[] }).candidates[0];
    expect(first).toMatchObject({ sourceId: "551033", year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr.", variation: null });
    // Automatic filling is off: the number stays as read (cut off on the photo).
    expect(item.cardNumber).toBeNull();
    expect(catalog.calls.length).toBeGreaterThan(0);
  });
  it("never offers the Tiffany card or Ken Griffey Sr. first", () => {
    const first = (item.catalog as { candidates: Candidate[] }).candidates[0];
    expect(first.player).not.toMatch(/Sr/);
    expect(first.variation ?? "").not.toMatch(/tiffany/i);
  });
});

describe("1990 Topps Ken Griffey Jr., recorded text, catalog off", () => {
  it("still gives a Griffey name, year 1990, no wrong number and no wrong team", async () => {
    const r = new FreeRecognizer({ reader: recordedReader(), lookup: async () => null });
    const [item] = await r.recognize({ mode: "single", photos: PHOTOS });
    checkStableFields(item);
    expect(item.player ?? "").toMatch(/Griffey/);
    expect(item.catalog).toBeUndefined();
    // Read exactly on a stat row with baseball stat headers: written without facts.
    expect(item.team).toBe("Seattle Mariners");
  });
});

/** The real reader (Python worker) only when OCR_TEST_PYTHON is set; see ocr.integration.test.ts. */
const TEST_PYTHON = process.env.OCR_TEST_PYTHON?.trim();

describe.skipIf(!TEST_PYTHON)("1990 Topps Ken Griffey Jr., read from the photos with the real text reader", () => {
  let item: RecognizedItem;
  const engine = TEST_PYTHON ? pythonEngine({ ...readerSettings(), python: TEST_PYTHON }) : null;

  beforeAll(async () => {
    const recognizer = new FreeRecognizer({ reader: createTextReader(engine!), lookup: async (name) => (/griffey/i.test(name) ? GRIFFEY_FACTS : null) });
    const started = Date.now();
    [item] = await recognizer.recognize({ mode: "single", photos: fixturePhotos(GRIFFEY) });
    console.log(`Griffey scan took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
  });

  it("reads sport, year, number, brand and no sentence words", () => checkStableFields(item));
  // The real reader does not return the same letters every run ("Criffey"), so the team is Mariners or empty, never another.
  it("never writes a wrong team", () => expect([null, "Seattle Mariners"]).toContain(item.team));
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

  it("reads year, sport, position and team", () => {
    expect(parsed.team).toBe("Seattle Mariners");
    expect(parsed.teamHint).toBeNull();
    expect(parsed.year).toBe(1990);
    expect(parsed.sport).toBe("baseball");
    expect(parsed.position).toBe("OF");
  });
});
