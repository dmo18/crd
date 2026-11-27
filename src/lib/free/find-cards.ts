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
/** Unevenly lit table: softening (pixels of the work picture), fitting rounds, spread allowed, every how many pixels fitted. */
const SHADE_BLUR = 2;
const SHADE_ROUNDS = 3;
const SHADE_SPREAD = 1.5;
const SHADE_STEP = 2;
/** How far (work picture pixels) a joined mask is shrunk to part cards lying close. */
/** A card has at least this many times the detail of the bare table. */
const PRINT_DETAIL = 2;
const SHRINK_STEPS = [0, 3, 6, 9] as const;
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
  /** The four corners of that rectangle, in pixels of the work picture. */
  corners: [number, number][];
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
  // Pixel centres span u0 to u1: the rectangle reaches half a pixel further each way.
  const corner = (u: number, v: number): [number, number] => [u * c - v * sn + 0.5, u * sn + v * c + 0.5];
  const corners = [corner(u0 - 0.5, v0 - 0.5), corner(u1 + 0.5, v0 - 0.5), corner(u1 + 0.5, v1 + 0.5), corner(u0 - 0.5, v1 + 0.5)];
  return { axisDeg, tiltDeg, fill: n / (lu * lv), aspect: Math.min(lu, lv) / Math.max(lu, lv), corners };
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

type Found = { box: PixelBox; tiltDeg: number; single: boolean; corners?: [number, number][] };

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
    // A tilted card's own rectangle; an upright one is its box.
    if (share <= MAX_AREA && cardLike(aspect)) singles.push({ box: c, tiltDeg: shape.tiltDeg, single: true, corners: tilted ? shape.corners : undefined });
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

/** Solves a small square linear system (Gauss with pivoting); zeros when it is singular. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    [m[i], m[p]] = [m[p], m[i]];
    const d = m[i][i];
    if (Math.abs(d) < 1e-12) return new Array<number>(n).fill(0);
    for (let k = i; k <= n; k++) m[i][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = m[r][i];
      if (f) for (let k = i; k <= n; k++) m[r][k] -= f * m[i][k];
    }
  }
  return m.map((row) => row[n]);
}

/** Terms of a smooth (second order) surface over the picture: lighting that falls off across a table. */
function terms(x: number, y: number): number[] {
  return [1, x, y, x * x, x * y, y * y];
}

/**
 * For a table lit unevenly (bright near a window, dark across the photo),
 * where one table colour does not fit the whole edge: the table's colour is
 * fitted as a smooth surface, first to the outer edge, then again to every
 * pixel that fits it, and a pixel is card when it differs clearly from that
 * surface. The picture is softened first so the table's grain does not count.
 * Holes inside a card (a dark photo on the card) are filled.
 */
async function shadedMask(px: Buffer, width: number, height: number): Promise<Uint8Array> {
  const soft = await sharp(px, { raw: { width, height, channels: 3 } }).blur(SHADE_BLUR).raw().toBuffer();
  const n = width * height;
  const band = Math.max(1, Math.round(Math.min(width, height) * BORDER_FRACTION));
  let use = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (y < band || y >= height - band || x < band || x >= width - band) use[y * width + x] = 1;
  }
  // Per pixel: how much brighter than the table (shade: darker, never card) and how different in colour.
  const lift = new Float64Array(n);
  const tint = new Float64Array(n);
  let liftMax = MIN_COLOR_DISTANCE;
  let tintMax = MIN_COLOR_DISTANCE;
  for (let round = 0; round < SHADE_ROUNDS; round++) {
    const fits = [0, 1, 2].map((ch) => {
      const a = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
      const b = new Array<number>(6).fill(0);
      for (let p = 0; p < n; p += SHADE_STEP) {
        if (!use[p]) continue;
        const t = terms((p % width) / width, Math.floor(p / width) / height);
        const v = soft[p * 3 + ch];
        for (let i = 0; i < 6; i++) {
          b[i] += t[i] * v;
          for (let j = 0; j < 6; j++) a[i][j] += t[i] * t[j];
        }
      }
      return solve(a, b);
    });
    const lifts: number[] = [];
    const tints: number[] = [];
    for (let p = 0; p < n; p++) {
      const t = terms((p % width) / width, Math.floor(p / width) / height);
      const d = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        let model = 0;
        for (let i = 0; i < 6; i++) model += fits[ch][i] * t[i];
        d[ch] = soft[p * 3 + ch] - model;
      }
      const l = (d[0] + d[1] + d[2]) / 3;
      lift[p] = l;
      tint[p] = Math.hypot(d[0] - l, d[1] - l, d[2] - l);
      if (use[p]) {
        lifts.push(Math.abs(l));
        tints.push(tint[p]);
      }
    }
    const p90 = (v: number[]) => v.sort((x, y) => x - y)[Math.floor(v.length * 0.9)] ?? 0;
    liftMax = Math.max(MIN_COLOR_DISTANCE, SHADE_SPREAD * p90(lifts));
    tintMax = Math.max(MIN_COLOR_DISTANCE, SHADE_SPREAD * p90(tints));
    use = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (Math.abs(lift[p]) < liftMax / 2 && tint[p] < tintMax / 2) use[p] = 1;
  }
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (lift[p] > liftMax || tint[p] > tintMax) mask[p] = 1;
  return clean(fillHoles(clean(mask, width, height), width, height), width, height);
}

/**
 * Light cards on a dark desk with a patch of glare (owner scan 8): the glare
 * joins the cards in every colour mask. Brightness is split into three
 * groups (desk, glare or shade, card) by the split that best separates them
 * (Otsu's rule for three groups), and only the brightest group is card. The
 * dark photo inside a card is filled from its light border.
 */
async function brightMask(px: Buffer, width: number, height: number): Promise<Uint8Array> {
  const n = width * height;
  // Softened a little, so print on the white border does not break it.
  const soft = await sharp(px, { raw: { width, height, channels: 3 } }).blur(1).raw().toBuffer();
  const lum = new Uint8Array(n);
  const hist = new Float64Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    lum[p] = Math.round(soft[i] * 0.299 + soft[i + 1] * 0.587 + soft[i + 2] * 0.114);
    hist[lum[p]]++;
  }
  // Running sums give each group's share and mean in constant time.
  const share = new Float64Array(257);
  const mass = new Float64Array(257);
  for (let v = 0; v < 256; v++) {
    share[v + 1] = share[v] + hist[v] / n;
    mass[v + 1] = mass[v] + (v * hist[v]) / n;
  }
  const mean = mass[256];
  const between = (from: number, to: number) => {
    const w = share[to] - share[from];
    return w > 0 ? (mass[to] - mass[from] - w * mean) ** 2 / w : 0;
  };
  let top = -1;
  let cut = 255;
  for (let a = 1; a < 255; a++) {
    for (let b = a + 1; b < 256; b++) {
      const v = between(0, a) + between(a, b) + between(b, 256);
      if (v > top) {
        top = v;
        cut = b;
      }
    }
  }
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (lum[p] >= cut) mask[p] = 1;
  return clean(fillHoles(clean(mask, width, height), width, height), width, height);
}

const foundArea = (f: Found) => (f.box.x1 - f.box.x0 + 1) * (f.box.y1 - f.box.y0 + 1);

/** A find at the photo's edge: a card cut by the frame, or something else lying there (a notebook, a keyboard). */
function atEdge(f: Found, width: number, height: number): boolean {
  return f.box.x0 <= 1 || f.box.y0 <= 1 || f.box.x1 >= width - 2 || f.box.y1 >= height - 2;
}

/**
 * Finds that look like the cards of this photo: about the size of the
 * others (cards of one scan are of one size), and a find at the edge of the
 * photo clearly smaller than the others is not one (a piece of a notebook,
 * a keyboard, a card cut by the frame).
 */
function plausible(found: Found[], width: number, height: number): Found[] {
  if (found.length < 2) return found;
  const typical = median(found.map(foundArea));
  return found.filter((f) => {
    const r = foundArea(f) / typical;
    if (r > PLAUSIBLE_MAX) return false;
    return r >= (atEdge(f, width, height) ? EDGE_MIN : PLAUSIBLE_MIN);
  });
}

/** A find bigger than this many typical cards is not a card; smaller than this share is not one either. */
const PLAUSIBLE_MAX = 2.6;
const PLAUSIBLE_MIN = 0.35;
/** A find at the photo's edge must be at least this share of a typical card. */
const EDGE_MIN = 0.6;

/**
 * Each way of telling cards from the desk (colour against the desk's edge,
 * strong outlines, a fitted unevenly lit desk, brightness) gives a set of
 * finds. The set with the most plausible cards wins; on a tie the earlier
 * way, as before. Finds that are not plausible cards are dropped.
 */
async function findCards(work: { data: Buffer; width: number; height: number }): Promise<Found[]> {
  const { data, width, height } = work;
  const ways: (() => Promise<Found[]>)[] = [
    async () => cardsInMask(clean(foregroundMask(data, width, height), width, height), data, width, height),
    async () => cardsInMask(await edgeMask(data, width, height), data, width, height),
    async () => withDetail(apart(await shadedMask(data, width, height), data, width, height), data, width, height),
    async () => withDetail(apart(await brightMask(data, width, height), data, width, height), data, width, height),
  ];
  let best: Found[] = [];
  for (const way of ways) {
    const got = plausible(await way(), width, height);
    if (got.length > best.length) best = got;
  }
  return best;
}

/** Mean brightness change between neighbouring pixels inside a box (print has much, bare table and glare little). */
function detail(px: Buffer, width: number, b: { x0: number; y0: number; x1: number; y1: number }): number {
  let sum = 0;
  let count = 0;
  const lum = (i: number) => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = (y * width + x) * 3;
      sum += Math.abs(lum(i + 3) - lum(i)) + Math.abs(lum(i + width * 3) - lum(i));
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Only blobs with print on them: a patch of glare on the table differs from
 * the table in brightness but has no more detail than the table itself.
 */
function withDetail(found: Found[], px: Buffer, width: number, height: number): Found[] {
  const band = Math.max(2, Math.round(Math.min(width, height) * BORDER_FRACTION));
  const table = median([
    detail(px, width, { x0: 0, y0: 0, x1: width - 1, y1: band }),
    detail(px, width, { x0: 0, y0: height - 1 - band, x1: width - 1, y1: height - 1 }),
    detail(px, width, { x0: 0, y0: 0, x1: band, y1: height - 1 }),
    detail(px, width, { x0: width - 1 - band, y0: 0, x1: width - 1, y1: height - 1 }),
  ]);
  return found.filter((f) => detail(px, width, f.box) >= PRINT_DETAIL * table);
}

/** A found card grown back by `r` pixels on every side (after the mask was shrunk by r). */
function grown(f: Found, r: number, width: number, height: number): Found {
  if (r === 0) return f;
  const b = f.box;
  const box = { ...b, x0: Math.max(0, b.x0 - r), y0: Math.max(0, b.y0 - r), x1: Math.min(width - 1, b.x1 + r), y1: Math.min(height - 1, b.y1 + r) };
  let corners = f.corners;
  if (corners) {
    const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
    const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
    corners = corners.map(([x, y]): [number, number] => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      // A corner moves out along the diagonal: r along each side is r times root 2 there.
      return [x + ((x - cx) / d) * r * Math.SQRT2, y + ((y - cy) / d) * r * Math.SQRT2];
    });
  }
  return { ...f, box, corners };
}

/**
 * Cards lying close together can join in the mask through a thin bridge
 * (soft light between them). The mask is shrunk step by step until it falls
 * apart into card shaped pieces; each piece is grown back by the same amount.
 * The step that finds the most card area wins; the least shrinking on a tie.
 */
function apart(mask: Uint8Array, px: Buffer, width: number, height: number): Found[] {
  let best: Found[] = [];
  let bestArea = 0;
  for (const r of SHRINK_STEPS) {
    const m = r === 0 ? mask : morph(mask, width, height, r, false);
    const found = cardsInMask(m, px, width, height).map((f) => grown(f, r, width, height));
    const covered = found.reduce((s, f) => s + (f.box.x1 - f.box.x0 + 1) * (f.box.y1 - f.box.y0 + 1), 0);
    if (covered > bestArea * 1.05) {
      best = found;
      bestArea = covered;
    }
  }
  return best;
}

/**
 * One card found in a photo: `box` the upright box around it (with a small
 * margin), `outline` the card's own four corners (fractions of the photo),
 * which differ from the box's corners when the card lies turned.
 */
export type CardShape = { box: Box; outline: [number, number][] };

function boxCorners(b: Box): [number, number][] {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
}

/** The cards in a photo of several cards, in reading order, or [] for a close-up of one card or no clear cards. */
export async function findCardShapes(image: Buffer): Promise<CardShape[]> {
  const work = await workImage(image);
  if (!work) return [];
  const { width, height } = work;
  const found = await findCards(work);
  if (found.length === 0) return [];
  const toBox = (b: PixelBox): Box => ({ x: b.x0 / width, y: b.y0 / height, w: (b.x1 - b.x0 + 1) / width, h: (b.y1 - b.y0 + 1) / height });
  // One card filling much of the photo is a close-up: the caller reads the whole photo.
  if (found.length === 1 && found[0].single && area(toBox(found[0].box)) >= SINGLE_CARD_AREA) return [];

  const shapes = found.map((f): CardShape => {
    const box = padAndClamp(toBox(f.box));
    const outline = f.corners
      ? f.corners.map(([x, y]): [number, number] => [x / width, y / height])
      : boxCorners(box);
    return { box, outline };
  });
  // Boxes that overlap much are one card seen twice: one box around both, its own outline.
  const merged = mergeOverlapping(shapes.map((s) => s.box));
  const out = merged.map((box): CardShape => {
    const same = shapes.filter((s) => s.box.x === box.x && s.box.y === box.y && s.box.w === box.w && s.box.h === box.h);
    return same.length === 1 ? same[0] : { box, outline: boxCorners(box) };
  });
  const order = readingOrder(out.map((s) => s.box));
  return order.map((b) => out.find((s) => s.box === b)!).slice(0, MAX_BOXES);
}

/**
 * The one card of a one card photo, as the many-cards finder sees it (its
 * masks cope with a dark desk and glare): a box, or null when it finds no
 * card or more than one. The caller still checks that the box is card
 * shaped and holds every text line.
 */
export async function findSingleCard(image: Buffer): Promise<Box | null> {
  const work = await workImage(image);
  if (!work) return null;
  const found = await findCards(work);
  if (found.length !== 1) return null;
  const b = found[0]!.box;
  return { x: b.x0 / work.width, y: b.y0 / work.height, w: (b.x1 - b.x0 + 1) / work.width, h: (b.y1 - b.y0 + 1) / work.height };
}

export async function findCardBoxes(image: Buffer): Promise<Box[]> {
  return (await findCardShapes(image)).map((s) => s.box);
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
