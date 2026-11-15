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

describe("sideways cards", () => {
  // Many 1980s backs are printed across the long side, so a phone photo of
  // the back held upright shows the text turned a quarter.
  const landscapeBack = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="750">
    <rect width="100%" height="100%" fill="#f1e7cf"/>
    <g font-family="DejaVu Sans, Arial, sans-serif" fill="#2a2a2a">
    <text x="40" y="70" font-size="40" font-weight="bold">616</text>
    <text x="200" y="70" font-size="40" font-weight="bold">BILL RIPKEN</text>
    <text x="200" y="120" font-size="26">BALTIMORE ORIOLES  2B</text>
    <text x="40" y="200" font-size="22">HT: 6'1" WT: 185 BATS: RIGHT THROWS: RIGHT</text>
    <text x="40" y="300" font-size="22">1987 ORIOLES 58 234 27 72 9 0 2 20 .308</text>
    <text x="40" y="700" font-size="20">\u00a9 1989 FLEER CORP. PRINTED IN U.S.A.</text></g></svg>`);

  it(
    "reads a back turned a quarter either way",
    async () => {
      for (const angle of [90, 270]) {
        const image = await sharp(landscapeBack).rotate(angle).jpeg({ quality: 90 }).toBuffer();
        const result = await getTextReader().read(image);
        expectWords(result, ["BILL", "RIPKEN", "1989", "FLEER"]);
        expect(result.confidence).toBeGreaterThan(0.6);
        expectBoxes(result);
      }
    },
    TIMEOUT,
  );
});

describe("otsuThreshold", () => {
  it("splits two clear groups of gray between them", async () => {
    const { otsuThreshold } = await import("./ocr");
    const pixels = new Uint8Array([...Array(900).fill(230), ...Array(100).fill(30)]);
    const t = otsuThreshold(pixels);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(230);
  });
});

describe("framed labels", () => {
  const box = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <rect width="100%" height="100%" fill="#55504a"/>
    <rect x="200" y="220" width="1200" height="760" fill="#c0392b"/>
    <rect x="200" y="220" width="1200" height="220" fill="#f6f1e1"/>
    <text x="800" y="360" font-family="sans-serif" font-size="84" font-weight="800" text-anchor="middle" fill="#111">1990 TOPPS BASEBALL</text>
    <rect x="420" y="600" width="760" height="180" fill="#f6f1e1"/>
    <text x="800" y="720" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#111">36 PACKS  WAX BOX</text></svg>`);

  it("finds light label areas", async () => {
    const { findLabelRegions } = await import("./ocr");
    const regions = await findLabelRegions(await sharp(box).jpeg().toBuffer());
    expect(regions.some((r) => Math.abs(r.y - 0.5) < 0.05 && Math.abs(r.x - 0.2625) < 0.05)).toBe(true);
  });

  it("reads a label inside a dark frame when asked to be thorough", async () => {
    const image = await sharp(box).jpeg({ quality: 90 }).toBuffer();
    const result = await getTextReader().read(image, { thorough: true });
    expect(result.text).toMatch(/1990 TOPPS BASEBALL/i);
    expect(result.text).toMatch(/36 PACKS/i);
    for (const l of result.lines) {
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(1.0001);
      expect(l.box.y + l.box.h).toBeLessThanOrEqual(1.0001);
    }
  }, 60000);
});
