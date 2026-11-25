import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Box } from "@/lib/recognition/types";
import fs from "node:fs";
import { LIVE_MANY_PHOTOS } from "../../../tests/helpers/ocr-fixture";
import { cardTilt, findCardBoxes } from "./find-cards";

const COLORS = ["#c0392b", "#2471a3", "#d4ac0d", "#7d3c98", "#1e8449", "#ca6f1e", "#566573", "#a93226", "#17a589"];

type Drawn = { x: number; y: number; w: number; h: number };

function card(d: Drawn, color: string, border: string, rotate = 0): string {
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  const inset = Math.round(d.w * 0.07);
  return `<g transform="rotate(${rotate} ${cx} ${cy})">
    <rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" fill="${border}"/>
    <rect x="${d.x + inset}" y="${d.y + inset}" width="${d.w - 2 * inset}" height="${d.h - 2 * inset}" fill="${color}"/>
    <rect x="${d.x + inset}" y="${d.y + d.h - inset * 3}" width="${d.w - 2 * inset}" height="${inset * 1.5}" fill="${border}"/>
  </g>`;
}

async function render(width: number, height: number, background: string, body: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${background}"/>${body}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

function grid(cols: number, rows: number, width: number, height: number, cw: number, ch: number): Drawn[] {
  const gx = (width - cols * cw) / (cols + 1);
  const gy = (height - rows * ch) / (rows + 1);
  const out: Drawn[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: Math.round(gx + c * (cw + gx)), y: Math.round(gy + r * (ch + gy)), w: cw, h: ch });
    }
  }
  return out;
}

function expectNear(found: Box, drawn: Drawn, width: number, height: number) {
  expect(Math.abs(found.x - drawn.x / width)).toBeLessThan(0.03);
  expect(Math.abs(found.y - drawn.y / height)).toBeLessThan(0.03);
  expect(Math.abs(found.x + found.w - (drawn.x + drawn.w) / width)).toBeLessThan(0.03);
  expect(Math.abs(found.y + found.h - (drawn.y + drawn.h) / height)).toBeLessThan(0.03);
}

function expectValid(boxes: Box[]) {
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
    expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
  }
}

describe("findCardBoxes", () => {
  it("finds a 3x3 grid on a dark green mat in reading order", async () => {
    const W = 1200;
    const H = 1600;
    const drawn = grid(3, 3, W, H, 300, 420);
    const img = await render(W, H, "#1d4d2b", drawn.map((d, i) => card(d, COLORS[i], "#f2efe6")).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(9);
    expectValid(boxes);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });

  it("finds a 2x2 grid on a white table", async () => {
    const W = 1600;
    const H = 1200;
    const drawn = grid(2, 2, W, H, 360, 504);
    const img = await render(W, H, "#ffffff", drawn.map((d, i) => card(d, COLORS[i + 3], "#c9c4b8")).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(4);
    expectValid(boxes);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });

  it("returns nothing for a single card filling the frame", async () => {
    const W = 1000;
    const H = 1400;
    const img = await render(W, H, "#f2efe6", card({ x: 0, y: 0, w: W, h: H }, "#2471a3", "#f2efe6"));
    expect(await findCardBoxes(img)).toEqual([]);
  });

  it("returns nothing when the only shapes are not card shaped", async () => {
    const img = await render(
      1600,
      1200,
      "#1d4d2b",
      `<circle cx="400" cy="600" r="120" fill="#e74c3c"/><rect x="800" y="200" width="120" height="900" fill="#f1c40f"/>`,
    );
    expect(await findCardBoxes(img)).toEqual([]);
  });

  it("still finds a slightly rotated card", async () => {
    const W = 1600;
    const H = 1200;
    const drawn: Drawn = { x: 600, y: 300, w: 400, h: 560 };
    const img = await render(W, H, "#1d4d2b", card(drawn, "#c0392b", "#f2efe6", 8));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(1);
    expectValid(boxes);
    const b = boxes[0];
    const cx = (drawn.x + drawn.w / 2) / W;
    const cy = (drawn.y + drawn.h / 2) / H;
    expect(Math.abs(b.x + b.w / 2 - cx)).toBeLessThan(0.03);
    expect(Math.abs(b.y + b.h / 2 - cy)).toBeLessThan(0.03);
    expect(b.w).toBeGreaterThan(drawn.w / W);
    expect(b.h).toBeGreaterThan(drawn.h / H);
  });

  it("splits two touching cards side by side", async () => {
    const W = 1600;
    const H = 1200;
    const drawn: Drawn[] = [{ x: 400, y: 300, w: 400, h: 560 }, { x: 800, y: 300, w: 400, h: 560 }];
    const img = await render(W, H, "#1d4d2b", drawn.map((d, i) => card(d, COLORS[i], "#f2efe6")).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(2);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });

  it("splits two touching cards end to end", async () => {
    const W = 1200;
    const H = 1600;
    const drawn: Drawn[] = [{ x: 450, y: 200, w: 330, h: 462 }, { x: 450, y: 662, w: 330, h: 462 }];
    const img = await render(W, H, "#1d4d2b", drawn.map((d, i) => card(d, COLORS[i + 2], "#f2efe6")).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(2);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });

  it("splits a pair that is twice the size of the other cards, even when the two look different", async () => {
    const W = 1600;
    const H = 1200;
    const single: Drawn = { x: 120, y: 320, w: 360, h: 504 };
    const pair: Drawn[] = [{ x: 700, y: 320, w: 360, h: 504 }, { x: 1060, y: 320, w: 360, h: 504 }];
    const body = card(single, COLORS[0], "#f2efe6") + card(pair[0], COLORS[1], "#f2efe6") + card(pair[1], "#111111", "#ddd8cc");
    const boxes = await findCardBoxes(await render(W, H, "#1d4d2b", body));
    expect(boxes).toHaveLength(3);
    expectNear(boxes[1], pair[0], W, H);
    expectNear(boxes[2], pair[1], W, H);
  });

  it("does not cut a landscape card in two", async () => {
    const W = 1600;
    const H = 1200;
    const drawn: Drawn[] = [{ x: 150, y: 350, w: 560, h: 400 }, { x: 900, y: 300, w: 400, h: 560 }];
    const body = card(drawn[0], COLORS[3], "#f2efe6") + card(drawn[1], COLORS[4], "#f2efe6");
    const boxes = await findCardBoxes(await render(W, H, "#1d4d2b", body));
    expect(boxes).toHaveLength(2);
    expectNear(boxes[0], drawn[0], W, H);
  });

  it("finds a touching 3x3 grid that covers most of the photo", async () => {
    const W = 1200;
    const H = 1600;
    const cw = 340;
    const ch = 476;
    const x0 = (W - 3 * cw) / 2;
    const y0 = (H - 3 * ch) / 2;
    const drawn: Drawn[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) drawn.push({ x: x0 + c * cw, y: y0 + r * ch, w: cw, h: ch });
    const img = await render(W, H, "#1d4d2b", drawn.map((d, i) => card(d, COLORS[i], "#f2efe6")).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(9);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });

  it("finds cards turned about 45 degrees and reports the turn on a crop", async () => {
    const W = 1600;
    const H = 1200;
    const drawn: Drawn[] = [{ x: 250, y: 320, w: 380, h: 532 }, { x: 970, y: 320, w: 380, h: 532 }];
    const img = await render(W, H, "#1d4d2b", card(drawn[0], COLORS[0], "#f2efe6", 45) + card(drawn[1], COLORS[1], "#f2efe6", -40));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(2);
    expectValid(boxes);
    const crop = async (b: Box) =>
      sharp(img).extract({ left: Math.round(b.x * W), top: Math.round(b.y * H), width: Math.round(b.w * W), height: Math.round(b.h * H) }).jpeg().toBuffer();
    expect(Math.abs(Math.abs(await cardTilt(await crop(boxes[0]))) - 45)).toBeLessThan(4);
    expect(Math.abs((await cardTilt(await crop(boxes[1]))) + 40)).toBeLessThan(4);
  });

  it("reports a small turn with its direction and none for an upright card", async () => {
    const W = 800;
    const H = 1000;
    const d: Drawn = { x: 200, y: 200, w: 400, h: 560 };
    expect(Math.abs((await cardTilt(await render(W, H, "#1d4d2b", card(d, COLORS[0], "#f2efe6", 12)))) - 12)).toBeLessThan(2);
    expect(Math.abs(await cardTilt(await render(W, H, "#1d4d2b", card(d, COLORS[0], "#f2efe6"))))).toBeLessThan(1.5);
  });

  it("finds white cards on a white table from their edges", async () => {
    const W = 1600;
    const H = 1200;
    const drawn = grid(2, 1, W, H, 400, 560);
    const whiteCard = (d: Drawn) => `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" fill="#fcfcfc" stroke="#c8c8c8" stroke-width="3"/>
      <rect x="${d.x + 40}" y="${d.y + 60}" width="${d.w - 80}" height="14" fill="#e6e6e6"/>
      <rect x="${d.x + 40}" y="${d.y + 100}" width="${d.w - 160}" height="14" fill="#e6e6e6"/>`;
    const img = await render(W, H, "#f6f6f6", drawn.map(whiteCard).join(""));
    const boxes = await findCardBoxes(img);
    expect(boxes).toHaveLength(2);
    boxes.forEach((b, i) => expectNear(b, drawn[i], W, H));
  });
});

describe("cards on a dark desk with glare and clutter (owner scan 8)", () => {
  it("in the owner's three photos: three cards each, not the glare, the notebook or the keyboard", async () => {
    for (const file of LIVE_MANY_PHOTOS) {
      const boxes = await findCardBoxes(fs.readFileSync(file));
      expectValid(boxes);
      expect(boxes, file).toHaveLength(3);
      for (const b of boxes) {
        // Each about one card's size, and none down where the notebook and keyboard lie.
        expect(b.w * b.h, file).toBeGreaterThan(0.06);
        expect(b.w * b.h, file).toBeLessThan(0.2);
        expect(b.y + b.h, file).toBeLessThan(0.85);
      }
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0, file).toBeLessThan(0.2);
        }
      }
    }
  });

  it("a made-up desk with glare and a notebook at the edge: each card, nothing else", async () => {
    const W = 924;
    const H = 2000;
    const drawn: Drawn[] = [
      { x: 200, y: 560, w: 520, h: 380 },
      { x: 40, y: 980, w: 380, h: 520 },
      { x: 500, y: 1000, w: 380, h: 520 },
    ];
    const body = `
      <defs><radialGradient id="g"><stop offset="0" stop-color="#8e8e8e"/><stop offset="0.7" stop-color="#787878"/><stop offset="1" stop-color="#262626"/></radialGradient></defs>
      <ellipse cx="120" cy="420" rx="330" ry="460" fill="url(#g)"/>
      ${card(drawn[0], COLORS[0], "#f2f2f2")}
      ${card(drawn[1], COLORS[1], "#f0e8e0")}
      ${card(drawn[2], COLORS[2], "#f2f2f2")}
      <g transform="rotate(-12 600 1950)"><rect x="300" y="1880" width="900" height="200" fill="#e8e8e8"/>
      ${Array.from({ length: 14 }, (_, i) => `<rect x="${330 + i * 60}" y="1890" width="22" height="60" fill="#303030"/>`).join("")}</g>`;
    const boxes = await findCardBoxes(await render(W, H, "#262626", body));
    expectValid(boxes);
    expect(boxes).toHaveLength(3);
    for (const d of drawn) {
      const hit = boxes.find((b) => Math.abs(b.x - d.x / W) < 0.05 && Math.abs(b.y - d.y / H) < 0.05);
      expect(hit, `card at ${d.x},${d.y}`).toBeDefined();
    }
  });
});
