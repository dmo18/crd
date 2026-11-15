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
/** Turned less than this, a blob counts as upright. */
const STRAIGHT_DEG = 4;
/** Touching cards: largest grid tried, piece shapes allowed, how well pieces must repeat. */
const MAX_GRID = 5;
const GRID_MIN_ASPECT = 0.6;
const GRID_MAX_ASPECT = 0.85;
const REPEAT_IF_CARD_SHAPED = 0.8;
const REPEAT_IF_LONG = 0.5;
/** Two cards end to end are about 0.36 short side to long side. */
const TWO_CARD_MIN_ASPECT = 0.3;
/** A card shaped blob this many times the typical card is two cards side by side. */
const TWICE_TYPICAL = 1.6;
/** Brightness profile spread below which a piece counts as plain (no pattern to compare). */
const MIN_PROFILE_SPREAD = 3;
/** Sobel strength (0 to about 1000) that counts as an edge. */
const EDGE_LEVEL = 40;
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

type Blob = PixelBox & { label: number; sx: number; sy: number; sxx: number; syy: number; sxy: number };

/** 8-connected blobs with their bounding boxes and moments, found with an explicit stack. */
function components(mask: Uint8Array, width: number, height: number): { blobs: Blob[]; labels: Int32Array } {
  const labels = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out: Blob[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = out.length + 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    const box: Blob = { x0: width, y0: height, x1: -1, y1: -1, count: 0, label, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      box.count++;
      box.sx += x;
      box.sy += y;
      box.sxx += x * x;
      box.syy += y * y;
      box.sxy += x * y;
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
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack[top++] = q;
          }
        }
      }
    }
    out.push(box);
  }
  return { blobs: out, labels };
}

type Shape = {
  /** Long axis direction from the moments, degrees, 0 is along the rows, clockwise positive. */
  axisDeg: number;
  /** Turn away from upright or flat, in (-45, 45]. */
  tiltDeg: number;
  /** Pixel share of the tightest rectangle along the long and short axes. */
  fill: number;
  /** Short side over long side of that rectangle. */
  aspect: number;
};

/**
 * The blob's own rectangle: its direction from second moments, then its extent
 * along that direction and across it. A card tilted 45 degrees fills only half
 * of its upright bounding box but nearly all of this rectangle.
 */
function shapeOf(b: Blob, labels: Int32Array, width: number): Shape {
  const n = b.count;
  const mx = b.sx / n;
  const my = b.sy / n;
  const cxx = b.sxx / n - mx * mx;
  const cyy = b.syy / n - my * my;
  const cxy = b.sxy / n - mx * my;
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (labels[y * width + x] !== b.label) continue;
      const u = x * c + y * sn;
      const v = -x * sn + y * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  }
  const lu = u1 - u0 + 1;
  const lv = v1 - v0 + 1;
  const axisDeg = (theta * 180) / Math.PI;
  let tiltDeg = axisDeg;
  while (tiltDeg > 45) tiltDeg -= 90;
  while (tiltDeg <= -45) tiltDeg += 90;
  return { axisDeg, tiltDeg, fill: n / (lu * lv), aspect: Math.min(lu, lv) / Math.max(lu, lv) };
}

/** Mean brightness per column (or row) inside a rectangle of the photo. */
function profile(px: Buffer, width: number, r: { x0: number; y0: number; x1: number; y1: number }, columns: boolean): Float64Array {
  const len = columns ? r.x1 - r.x0 + 1 : r.y1 - r.y0 + 1;
  const out = new Float64Array(len);
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = (y * width + x) * 3;
      out[columns ? x - r.x0 : y - r.y0] += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    }
  }
  const depth = columns ? r.y1 - r.y0 + 1 : r.x1 - r.x0 + 1;
  for (let k = 0; k < len; k++) out[k] /= depth;
  return out;
}

function resample(src: Float64Array, from: number, to: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = src[Math.min(src.length - 1, Math.floor(from + ((to - from) * k) / n))];
  return out;
}

/** Pearson correlation; 0 when either side is flat. */
function correlation(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let k = 0; k < n; k++) {
    ma += a[k];
    mb += b[k];
  }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < n; k++) {
    sab += (a[k] - ma) * (b[k] - mb);
    saa += (a[k] - ma) ** 2;
    sbb += (b[k] - mb) ** 2;
  }
  const flat = MIN_PROFILE_SPREAD * MIN_PROFILE_SPREAD * n;
  if (saa < flat || sbb < flat) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * How much the pieces of a row (or column) of touching cards repeat each other:
 * the lowest correlation of each piece's brightness profile with the first.
 * Cards have a border on every side, so a run of cards repeats every card width,
 * while one card does not repeat itself shifted by half its width.
 */
function repeats(prof: Float64Array, parts: number): number {
  if (parts <= 1) return 1;
  const step = prof.length / parts;
  const n = Math.max(8, Math.round(step));
  const first = resample(prof, 0, step, n);
  let worst = 1;
  for (let j = 1; j < parts; j++) worst = Math.min(worst, correlation(first, resample(prof, j * step, (j + 1) * step, n)));
  return worst;
}

type Grid = { cols: number; rows: number; score: number };

/** The best way to cut a blob into equal card shaped pieces, by how well the pieces repeat. */
function bestGrid(px: Buffer, width: number, b: PixelBox): Grid | null {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const colProf = profile(px, width, b, true);
  const rowProf = profile(px, width, b, false);
  let best: Grid | null = null;
  for (let cols = 1; cols <= MAX_GRID; cols++) {
    for (let rows = 1; rows <= MAX_GRID; rows++) {
      if (cols === 1 && rows === 1) continue;
      const pw = bw / cols;
      const ph = bh / rows;
      const aspect = Math.min(pw, ph) / Math.max(pw, ph);
      if (aspect < GRID_MIN_ASPECT || aspect > GRID_MAX_ASPECT) continue;
      const score = Math.min(repeats(colProf, cols), repeats(rowProf, rows));
      if (!best || score > best.score) best = { cols, rows, score };
    }
  }
  return best;
}

function splitBox(b: PixelBox, cols: number, rows: number): PixelBox[] {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const out: PixelBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = b.x0 + Math.round((c * bw) / cols);
      const y0 = b.y0 + Math.round((r * bh) / rows);
      const x1 = b.x0 + Math.round(((c + 1) * bw) / cols) - 1;
      const y1 = b.y0 + Math.round(((r + 1) * bh) / rows) - 1;
      out.push({ x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) });
    }
  }
  return out;
}

/** Halves along the long side, for two touching cards that make one blob. */
function halves(b: PixelBox): PixelBox[] {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  return bw >= bh ? splitBox(b, 2, 1) : splitBox(b, 1, 2);
}

function cardLike(aspect: number): boolean {
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
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

type Found = { box: PixelBox; tiltDeg: number; single: boolean };

/** Card shaped blobs in a mask, with touching cards cut apart. */
function cardsInMask(mask: Uint8Array, px: Buffer, width: number, height: number): Found[] {
  const total = width * height;
  const { blobs, labels } = components(mask, width, height);
  const singles: Found[] = [];
  const multi: { blob: Blob; aspect: number }[] = [];
  for (const c of blobs) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const bboxArea = bw * bh;
    const share = bboxArea / total;
    if (share < MIN_AREA || c.count < 50) continue;
    const upright = c.count / bboxArea;
    const shape = shapeOf(c, labels, width);
    const tilted = Math.abs(shape.tiltDeg) > STRAIGHT_DEG;
    // An upright blob is judged by its box; a tilted one by its own rectangle.
    const fill = tilted ? shape.fill : Math.max(upright, shape.fill);
    if (fill < MIN_FILL) continue;
    const aspect = tilted ? shape.aspect : Math.min(bw, bh) / Math.max(bw, bh);
    if (!tilted && upright >= MIN_FILL) multi.push({ blob: c, aspect });
    if (share <= MAX_AREA && cardLike(aspect)) singles.push({ box: c, tiltDeg: shape.tiltDeg, single: true });
  }

  // Touching cards make one blob. Cut it when its pieces repeat like a row or
  // grid of cards, or when it is two cards long and much bigger than the rest.
  const typical = median(singles.map((f) => (f.box.x1 - f.box.x0 + 1) * (f.box.y1 - f.box.y0 + 1)));
  const out: Found[] = [];
  const cut = new Set<PixelBox>();
  for (const { blob, aspect } of multi) {
    const bw = blob.x1 - blob.x0 + 1;
    const bh = blob.y1 - blob.y0 + 1;
    const grid = bestGrid(px, width, blob);
    let pieces: PixelBox[] | null = null;
    if (grid && grid.score >= (cardLike(aspect) ? REPEAT_IF_CARD_SHAPED : REPEAT_IF_LONG)) pieces = splitBox(blob, grid.cols, grid.rows);
    else if (aspect >= TWO_CARD_MIN_ASPECT && aspect < MIN_ASPECT) pieces = halves(blob);
    else if (cardLike(aspect) && typical > 0 && (bw * bh) / typical >= TWICE_TYPICAL && (bw * bh) / typical <= 2.6) pieces = halves(blob);
    if (!pieces) continue;
    const ok = pieces.every((p) => cardLike(Math.min(p.x1 - p.x0 + 1, p.y1 - p.y0 + 1) / Math.max(p.x1 - p.x0 + 1, p.y1 - p.y0 + 1)));
    if (!ok) continue;
    cut.add(blob);
    for (const p of pieces) out.push({ box: p, tiltDeg: 0, single: false });
  }
  for (const f of singles) if (!cut.has(f.box)) out.push(f);
  return out;
}

/** Grows edge pixels into outlines, then fills each closed outline. */
function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;
  const push = (p: number) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack[top++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    const p = stack[--top];
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < mask.length - width) push(p + width);
  }
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) out[p] = outside[p] ? 0 : 1;
  return out;
}

/**
 * For light cards on a light table, where colour alone does not separate them:
 * marks strong brightness edges (Sobel), joins them into outlines and fills them.
 */
async function edgeMask(px: Buffer, width: number, height: number): Promise<Uint8Array> {
  const gray = Buffer.alloc(width * height);
  for (let p = 0, i = 0; p < gray.length; p++, i += 3) gray[p] = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
  const sobel = async (kernel: number[]) =>
    sharp(gray, { raw: { width, height, channels: 1 } })
      .convolve({ width: 3, height: 3, kernel, scale: 1, offset: 128 })
      .raw()
      .toBuffer();
  const gx = await sobel([-1, 0, 1, -2, 0, 2, -1, 0, 1]);
  const gy = await sobel([-1, -2, -1, 0, 0, 0, 1, 2, 1]);
  const mask = new Uint8Array(width * height);
  const channels = Math.max(1, Math.round(gx.length / (width * height)));
  for (let p = 0; p < mask.length; p++) {
    const m = Math.abs(gx[p * channels] - 128) + Math.abs(gy[p * channels] - 128);
    if (m >= EDGE_LEVEL) mask[p] = 1;
  }
  const closed = morph(morph(mask, width, height, MORPH_RADIUS, true), width, height, MORPH_RADIUS, false);
  return clean(fillHoles(closed, width, height), width, height);
}

async function workImage(image: Buffer): Promise<{ data: Buffer; width: number; height: number } | null> {
  const { data, info } = await sharp(image, DECODE_OPTIONS)
    .rotate()
    .resize(WORK_EDGE, WORK_EDGE, { fit: "inside" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width < 10 || info.height < 10) return null;
  return { data, width: info.width, height: info.height };
}

async function findCards(work: { data: Buffer; width: number; height: number }): Promise<Found[]> {
  const { data, width, height } = work;
  let found = cardsInMask(clean(foregroundMask(data, width, height), width, height), data, width, height);
  if (found.length === 0) found = cardsInMask(await edgeMask(data, width, height), data, width, height);
  return found;
}

export async function findCardBoxes(image: Buffer): Promise<Box[]> {
  const work = await workImage(image);
  if (!work) return [];
  const { width, height } = work;
  const found = await findCards(work);
  if (found.length === 0) return [];
  const toBox = (b: PixelBox): Box => ({ x: b.x0 / width, y: b.y0 / height, w: (b.x1 - b.x0 + 1) / width, h: (b.y1 - b.y0 + 1) / height });
  // One card filling much of the photo is a close-up: the caller reads the whole photo.
  if (found.length === 1 && found[0].single && area(toBox(found[0].box)) >= SINGLE_CARD_AREA) return [];

  const merged = mergeOverlapping(found.map((f) => padAndClamp(toBox(f.box))));
  return readingOrder(merged).slice(0, MAX_BOXES);
}

/**
 * How far the main card in a photo (usually a crop around one card) is turned
 * from upright, in degrees, clockwise positive, between -45 and 45. 0 when no
 * card shape is found. Turning the photo by minus this straightens the card.
 */
export async function cardTilt(image: Buffer): Promise<number> {
  const work = await workImage(image);
  if (!work) return 0;
  const { data, width, height } = work;
  const mask = clean(foregroundMask(data, width, height), width, height);
  const { blobs, labels } = components(mask, width, height);
  let biggest: Blob | null = null;
  for (const b of blobs) if (!biggest || b.count > biggest.count) biggest = b;
  if (!biggest || biggest.count < width * height * 0.1) return 0;
  const shape = shapeOf(biggest, labels, width);
  if (shape.fill < MIN_FILL || !cardLike(shape.aspect)) return 0;
  return Math.round(shape.tiltDeg * 10) / 10;
}
