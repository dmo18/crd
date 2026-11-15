import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { closeTextReader, getTextReader, type OcrResult } from "./ocr";

const TIMEOUT = 60_000;

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

afterAll(async () => {
  await closeTextReader();
});

describe("text reader", () => {
  it(
    "reads a light card back",
    async () => {
      const result = await getTextReader().read(await jpeg(cardSvg("#f3ecd8", "#222222")));
      expectWords(result, ["414", "FRANK", "THOMAS", "WHITE", "SOX", "1990", "TOPPS"]);
      expect(result.confidence).toBeGreaterThan(0.5);
      expectBoxes(result);
      // The name line sits in the top part of the card.
      const nameLine = result.lines.find((l) => l.text.toUpperCase().includes("THOMAS"));
      expect(nameLine).toBeDefined();
      expect(nameLine!.box.y).toBeLessThan(0.3);
    },
    TIMEOUT,
  );

  it(
    "reads light text on a dark card",
    async () => {
      const result = await getTextReader().read(await jpeg(cardSvg("#1b2a4a", "#f0e6c8")));
      expectWords(result, ["FRANK", "THOMAS", "WHITE", "SOX"]);
      expect(result.confidence).toBeGreaterThan(0.5);
      expectBoxes(result);
    },
    TIMEOUT,
  );

  it(
    "returns empty text for a blank image",
    async () => {
      const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } })
        .jpeg()
        .toBuffer();
      const result = await getTextReader().read(blank);
      expect(result.text).toBe("");
      expect(result.lines).toEqual([]);
      expect(result.confidence).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "handles two reads at the same time",
    async () => {
      const reader = getTextReader();
      const [a, b] = await Promise.all([
        reader.read(await jpeg(cardSvg("#f3ecd8", "#222222"))),
        reader.read(await jpeg(cardSvg("#ffffff", "#0a2a6a"))),
      ]);
      expectWords(a, ["FRANK", "THOMAS"]);
      expectWords(b, ["FRANK", "THOMAS"]);
    },
    TIMEOUT,
  );
});
