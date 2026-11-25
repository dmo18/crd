import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { GRIFFEY, readFixture, readRealCard, REAL_CARDS } from "../../../tests/helpers/ocr-fixture";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { createTextReader, MAX_PASSES, pythonEngine, readerSettings, type OcrResult } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * The real text reader (Python worker with RapidOCR). Skipped unless
 * OCR_TEST_PYTHON points at a Python that has rapidocr installed, for example:
 *
 *   OCR_TEST_PYTHON=/path/to/venv/bin/python npx vitest run src/lib/free/ocr.integration.test.ts
 *
 * Models are read from OCR_MODELS_DIR, or RapidOCR's own models folder.
 * Record the Griffey text again with UPDATE_OCR=1 added.
 */
const PYTHON = process.env.OCR_TEST_PYTHON?.trim();
const TIMEOUT = 120_000;
const REAL = path.join(process.cwd(), "tests", "fixtures", "real-cards");

const engine = PYTHON ? pythonEngine({ ...readerSettings(), python: PYTHON }) : null;
const reader = engine ? createTextReader(engine) : null;

afterAll(async () => {
  await engine?.close();
});

function cardSvg(background: string, ink: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="500">
    <rect width="100%" height="100%" fill="${background}"/>
    <rect x="20" y="20" width="660" height="460" fill="none" stroke="${ink}" stroke-width="4"/>
    <g font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" fill="${ink}">
      <text x="60" y="110" font-size="44">NO. 414 FRANK THOMAS</text>
      <text x="60" y="200" font-size="40">WHITE SOX 1B</text>
      <text x="60" y="420" font-size="26">© 1990 THE TOPPS COMPANY, INC.</text>
    </g>
  </svg>`);
}

async function jpeg(svg: Buffer): Promise<Buffer> {
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

function expectWords(result: OcrResult, words: string[]) {
  const text = result.text.toUpperCase();
  for (const w of words) expect(text).toContain(w);
}

function expectBoxes(result: OcrResult) {
  expect(result.lines.length).toBeGreaterThan(0);
  for (const line of result.lines) {
    expect(line.confidence).toBeGreaterThanOrEqual(0.3);
    expect(line.confidence).toBeLessThanOrEqual(1);
    const { x, y, w, h } = line.box;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(x + w).toBeLessThanOrEqual(1 + 1e-9);
    expect(y + h).toBeLessThanOrEqual(1 + 1e-9);
  }
}

describe.skipIf(!reader)("real text reader: the owner's photos", () => {
  it(
    "reads MILACKI on the Milacki front and 24 on the Mills back",
    async () => {
      const t0 = Date.now();
      const front = await reader!.read(fs.readFileSync(path.join(REAL, "milacki-front.avif")));
      const t1 = Date.now();
      const back = await reader!.read(fs.readFileSync(path.join(REAL, "mills-back.avif")));
      const t2 = Date.now();
      console.log(`milacki front ${((t1 - t0) / 1000).toFixed(1)} s (${front.passes} passes), mills back ${((t2 - t1) / 1000).toFixed(1)} s (${back.passes} passes)`);
      expect(front.text.toUpperCase()).toContain("MILACKI");
      expect(back.lines.some((l) => /(?:^|\D)24(?:\D|$)/.test(l.text))).toBe(true);
      expectBoxes(front);
      expectBoxes(back);
    },
    TIMEOUT,
  );
});

describe.skipIf(!reader)("real text reader: the owner's four cards", () => {
  it(
    "reads each card in under 40 s, with the corner numbers on the backs (UPDATE_OCR=1 records them)",
    async () => {
      for (const id of REAL_CARDS) {
        const started = Date.now();
        const { front, back } = await readRealCard(id, reader!);
        const seconds = (Date.now() - started) / 1000;
        console.log(`${id}: ${seconds.toFixed(1)} s (front ${front.passes} passes ${front.crops} crops, back ${back.passes} passes ${back.crops} crops)`);
        expect(seconds).toBeLessThan(40);
        expect(front.passes).toBeLessThanOrEqual(MAX_PASSES);
        expect(back.passes).toBeLessThanOrEqual(MAX_PASSES);
        expectBoxes(front);
        expectBoxes(back);
      }
    },
    4 * TIMEOUT,
  );
});

describe.skipIf(!reader)("real text reader: drawn cards", () => {
  it(
    "reads a light card back, with the name line near the top",
    async () => {
      const result = await reader!.read(await jpeg(cardSvg("#f3ecd8", "#222222")));
      expectWords(result, ["414", "FRANK", "THOMAS", "WHITE", "SOX", "1990", "TOPPS"]);
      expect(result.confidence).toBeGreaterThan(0.5);
      expectBoxes(result);
      const nameLine = result.lines.find((l) => l.text.toUpperCase().includes("THOMAS"));
      expect(nameLine!.box.y).toBeLessThan(0.3);
    },
    TIMEOUT,
  );

  it(
    "reads light text on a dark card",
    async () => {
      const result = await reader!.read(await jpeg(cardSvg("#1b2a4a", "#f0e6c8")));
      expectWords(result, ["FRANK", "THOMAS", "WHITE", "SOX"]);
      expect(result.confidence).toBeGreaterThan(0.5);
      expectBoxes(result);
    },
    TIMEOUT,
  );

  it(
    "returns empty text for a blank image",
    async () => {
      const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
      const result = await reader!.read(blank);
      expect(result.text).toBe("");
      expect(result.lines).toEqual([]);
      expect(result.confidence).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "handles two reads at the same time",
    async () => {
      const [a, b] = await Promise.all([
        reader!.read(await jpeg(cardSvg("#f3ecd8", "#222222"))),
        reader!.read(await jpeg(cardSvg("#ffffff", "#0a2a6a"))),
      ]);
      expectWords(a, ["FRANK", "THOMAS"]);
      expectWords(b, ["FRANK", "THOMAS"]);
    },
    TIMEOUT,
  );

  it(
    "reads a back turned a quarter either way and returns boxes for the card upright",
    async () => {
      const landscapeBack = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="750">
        <rect width="100%" height="100%" fill="#f1e7cf"/>
        <g font-family="DejaVu Sans, Arial, sans-serif" fill="#2a2a2a">
        <text x="40" y="70" font-size="40" font-weight="bold">616</text>
        <text x="200" y="70" font-size="40" font-weight="bold">BILL RIPKEN</text>
        <text x="200" y="120" font-size="26">BALTIMORE ORIOLES  2B</text>
        <text x="40" y="200" font-size="22">HT: 6'1" WT: 185 BATS: RIGHT THROWS: RIGHT</text>
        <text x="40" y="300" font-size="22">1987 ORIOLES 58 234 27 72 9 0 2 20 .308</text>
        <text x="40" y="700" font-size="20">© 1989 FLEER CORP. PRINTED IN U.S.A.</text></g></svg>`);
      for (const angle of [90, 270]) {
        const image = await sharp(landscapeBack).rotate(angle).jpeg({ quality: 90 }).toBuffer();
        const result = await reader!.read(image);
        expectWords(result, ["BILL", "RIPKEN", "1989", "FLEER"]);
        expect(result.confidence).toBeGreaterThan(0.6);
        expect(result.passes).toBe(2);
        expectBoxes(result);
        const name = result.lines.find((l) => /RIPKEN/i.test(l.text))!;
        expect(name.box.y, `turned ${angle}`).toBeLessThan(0.2);
        expect(name.box.w).toBeGreaterThan(name.box.h);
      }
    },
    TIMEOUT,
  );

  it(
    "reads a label inside a dark frame when asked to be thorough",
    async () => {
      const box = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
        <rect width="100%" height="100%" fill="#55504a"/>
        <rect x="200" y="220" width="1200" height="760" fill="#c0392b"/>
        <rect x="200" y="220" width="1200" height="220" fill="#f6f1e1"/>
        <text x="800" y="360" font-family="sans-serif" font-size="84" font-weight="800" text-anchor="middle" fill="#111">1990 TOPPS BASEBALL</text>
        <rect x="420" y="600" width="760" height="180" fill="#f6f1e1"/>
        <text x="800" y="720" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#111">36 PACKS  WAX BOX</text></svg>`);
      const result = await reader!.read(await sharp(box).jpeg({ quality: 90 }).toBuffer(), { thorough: true });
      expect(result.text).toMatch(/1990 TOPPS BASEBALL/i);
      expect(result.text).toMatch(/36 PACKS/i);
      expectBoxes(result);
    },
    TIMEOUT,
  );

  it(
    "reads white on black and black on orange name strips",
    async () => {
      const front = (band: string, ink: string, name: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840">
        <rect width="100%" height="100%" fill="#d9d4c7"/>
        <rect x="30" y="30" width="540" height="780" fill="#6f8fa8"/>
        <circle cx="300" cy="420" r="170" fill="#8a6b52"/>
        <rect x="60" y="690" width="510" height="80" fill="${band}"/>
        <text x="90" y="748" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" font-weight="bold" fill="${ink}">${name}</text>
      </svg>`);
      const cases: [string, string, string, RegExp][] = [
        ["#111111", "#ffffff", "KEN GRIFFEY, JR.", /GRIFFEY/i],
        ["#f26a1b", "#111111", "CAL RIPKEN, JR.", /RIPKEN/i],
      ];
      for (const [band, ink, name, re] of cases) {
        const result = await reader!.read(await jpeg(front(band, ink, name)));
        const line = result.lines.find((l) => re.test(l.text));
        expect(line, name).toBeDefined();
        expect(line!.box.y).toBeGreaterThan(0.75);
        expect(result.passes).toBeLessThanOrEqual(MAX_PASSES);
        expectBoxes(result);
      }
    },
    TIMEOUT,
  );

  it(
    "reads the year from upright print by the right edge",
    async () => {
      const back = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700">
        <rect width="100%" height="100%" fill="#f3ecd8"/>
        <g font-family="DejaVu Sans, Arial, sans-serif" fill="#222">
          <text x="60" y="110" font-size="48" font-weight="bold">KEN GRIFFEY, JR. OF</text>
          <text x="60" y="220" font-size="30">BATS: LEFT THROWS: LEFT</text>
          <text transform="translate(965 640) rotate(-90)" font-size="24">© 1990 THE TOPPS COMPANY, INC.</text>
        </g></svg>`);
      const result = await reader!.read(await jpeg(back));
      const line = result.lines.find((l) => /1990/.test(l.text));
      expect(line).toBeDefined();
      expect(line!.box.x).toBeGreaterThan(0.85);
      expect(result.passes).toBeLessThanOrEqual(MAX_PASSES);
      expectBoxes(result);
    },
    TIMEOUT,
  );

  it(
    "reads the Griffey photos within the time limit",
    async () => {
      await reader!.read(await jpeg(cardSvg("#f3ecd8", "#222222")));
      const started = Date.now();
      const { front, back } = await readFixture(GRIFFEY, reader!);
      const seconds = (Date.now() - started) / 1000;
      console.log(`Griffey photos read in ${seconds.toFixed(1)} s (front ${front.passes} passes, back ${back.passes} passes)`);
      expect(seconds).toBeLessThan(40);
      expect(front.lines.some((l) => /GRIFFEY/i.test(l.text))).toBe(true);
      expect(back.lines.some((l) => /GRIFFEY/i.test(l.text) && l.box.y < 0.25)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "identifies a printed card back end to end",
    async () => {
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400">
        <rect width="100%" height="100%" fill="#e9dfc4"/>
        <text x="70" y="140" font-family="sans-serif" font-size="64" font-weight="700" fill="#222">NO. 1</text>
        <text x="70" y="260" font-family="sans-serif" font-size="64" font-weight="700" fill="#222">KEN GRIFFEY JR.</text>
        <text x="70" y="340" font-family="sans-serif" font-size="40" fill="#222">SEATTLE MARINERS  OF</text>
        <text x="70" y="1300" font-family="sans-serif" font-size="32" fill="#222">© 1989 THE UPPER DECK CO.</text></svg>`);
      const data = await sharp(svg).jpeg({ quality: 90 }).toBuffer();
      const r = new FreeRecognizer({ reader: reader!, lookup: async () => null });
      const [item] = await r.recognize({ mode: "single", photos: [{ role: "front", data, width: 1000, height: 1400 }] });
      expect(item).toMatchObject({ year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", rarityTier: "grail" });
      // Identified through the key card list, yet year, brand and name are each
      // printed once on this made-up side: not sure, so it waits for the owner
      // (only player, year and brand all sure may be filed alone, 12R.5 round 2).
      expect(item.evidence?.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
      expect(item.confidence).toBeLessThan(REVIEW_THRESHOLD);
    },
    TIMEOUT,
  );
});
