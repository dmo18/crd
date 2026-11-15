import sharp from "sharp";
import type { Box } from "@/lib/recognition/types";

/**
 * Finds separate cards laid flat on a plain, contrasting surface, with no AI.
 * Works on a small copy of the photo: estimates the surface colour from the
 * outer edge, marks everything that differs from it, cleans that mask, and
 * keeps the card-shaped blobs. Returns [] when it cannot tell cards apart,
 * so the caller treats the whole photo as one card.
 */

const WORK_EDGE = 500;
const BORDER_FRACTION = 0.03;
const MIN_COLOR_DISTANCE = 30;
const MORPH_RADIUS = 2;
const MIN_AREA = 0.015;
const MAX_AREA = 0.6;
const MIN_FILL = 0.55;
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 0.9;
const PAD = 0.01;
const MAX_BOXES = 30;
/** One card found and covering at least this much of the photo means "a close-up of one card". */
const SINGLE_CARD_AREA = 0.35;
const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;

type PixelBox = { x0: number; y0: number; x1: number; y1: number; count: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Marks pixels that differ from the surface colour seen around the edge. */
function foregroundMask(px: Buffer, width: number, height: number): Uint8Array {
  const band = Math.max(1, Math.round(Math.min(width, height) * BORDER_FRACTION));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const borderIdx: number[] = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= band && x < width - band) continue;
      const i = (y * width + x) * 3;
      r.push(px[i]);
      g.push(px[i + 1]);
      b.push(px[i + 2]);
      borderIdx.push(i);
    }
  }
  const br = median(r);
  const bg = median(g);
  const bb = median(b);

  const dist = new Float64Array(borderIdx.length);
  for (let k = 0; k < borderIdx.length; k++) {
    const i = borderIdx[k];
    dist[k] = Math.hypot(px[i] - br, px[i + 1] - bg, px[i + 2] - bb);
  }
  // Allow for the surface's own texture and shading: twice its 90th percentile spread.
  const threshold = Math.max(MIN_COLOR_DISTANCE, 2 * percentile(dist, 0.9));
  const limit = threshold * threshold;

  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const dr = px[i] - br;
    const dg = px[i + 1] - bg;
    const db = px[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > limit) mask[p] = 1;
  }
  return mask;
}

/**
 * One pass of a square dilate (grow) or erode (shrink) along rows or columns,
 * using a running count so the cost does not depend on the radius.
 * Outside the image counts as background.
 */
function pass(src: Uint8Array, width: number, height: number, r: number, grow: boolean, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  const lines = horizontal ? height : width;
  const len = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const window = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const start = horizontal ? l * width : l;
    let count = 0;
    for (let k = 0; k < Math.min(r, len); k++) count += src[start + k * step];
    for (let k = 0; k < len; k++) {
      const add = k + r;
      if (add < len) count += src[start + add * step];
      const drop = k - r - 1;
      if (drop >= 0) count -= src[start + drop * step];
      out[start + k * step] = grow ? (count > 0 ? 1 : 0) : count === window ? 1 : 0;
    }
  }
  return out;
}

function morph(mask: Uint8Array, width: number, height: number, r: number, grow: boolean): Uint8Array {
  return pass(pass(mask, width, height, r, grow, true), width, height, r, grow, false);
}

/** Close (fills small gaps) then open (removes specks). */
function clean(mask: Uint8Array, width: number, height: number): Uint8Array {
  const closed = morph(morph(mask, width, height, MORPH_RADIUS, true), width, height, MORPH_RADIUS, false);
  return morph(morph(closed, width, height, MORPH_RADIUS, false), width, height, MORPH_RADIUS, true);
}

/** Bounding boxes of 8-connected blobs, found with an explicit stack. */
function components(mask: Uint8Array, width: number, height: number): PixelBox[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out: PixelBox[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const box: PixelBox = { x0: width, y0: height, x1: -1, y1: -1, count: 0 };
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      box.count++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    out.push(box);
  }
  return out;
}

function area(b: Box): number {
  return b.w * b.h;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function mergeOverlapping(boxes: Box[]): Box[] {
  const list = [...boxes];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlap(list[i], list[j]) > 0.5 * Math.min(area(list[i]), area(list[j]))) {
          list[i] = union(list[i], list[j]);
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

/** Rows top to bottom (centres within half a box height share a row), then left to right. */
function readingOrder(boxes: Box[]): Box[] {
  const byY = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const rows: Box[][] = [];
  for (const box of byY) {
    const row = rows[rows.length - 1];
    const cy = box.y + box.h / 2;
    if (row) {
      const ref = row[0];
      if (Math.abs(cy - (ref.y + ref.h / 2)) <= ref.h / 2) {
        row.push(box);
        continue;
      }
    }
    rows.push([box]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

function padAndClamp(b: Box): Box {
  const x0 = Math.max(0, b.x - PAD);
  const y0 = Math.max(0, b.y - PAD);
  const x1 = Math.min(1, b.x + b.w + PAD);
  const y1 = Math.min(1, b.y + b.h + PAD);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export async function findCardBoxes(image: Buffer): Promise<Box[]> {
  const { data, info } = await sharp(image, DECODE_OPTIONS)
    .rotate()
    .resize(WORK_EDGE, WORK_EDGE, { fit: "inside" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (info.channels !== 3 || width < 10 || height < 10) return [];

  const mask = clean(foregroundMask(data, width, height), width, height);
  const total = width * height;

  const kept: Box[] = [];
  for (const c of components(mask, width, height)) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const bboxArea = bw * bh;
    const share = bboxArea / total;
    if (share < MIN_AREA || share > MAX_AREA) continue;
    if (c.count / bboxArea < MIN_FILL) continue;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
    kept.push({ x: c.x0 / width, y: c.y0 / height, w: bw / width, h: bh / height });
  }

  if (kept.length === 0) return [];
  if (kept.length === 1 && area(kept[0]) >= SINGLE_CARD_AREA) return [];

  const merged = mergeOverlapping(kept.map(padAndClamp));
  return readingOrder(merged).slice(0, MAX_BOXES);
}
