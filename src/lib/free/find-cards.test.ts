import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Box } from "@/lib/recognition/types";
import { findCardBoxes } from "./find-cards";

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
});
