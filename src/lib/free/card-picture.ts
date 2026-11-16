import sharp from "sharp";
import type { Box } from "@/lib/recognition/types";

/**
 * Picture work before reading (12R.3): find the card in a phone photo, and
 * plan the small extra reads (corners of a back for the card number, wide
 * bands of spaced letters squeezed together). Pure geometry on pixels and
 * line boxes; the reading itself is in ocr.ts.
 */

const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;
/** Long edge of the small grey copy the card is looked for in. */
const FIND_EDGE = 200;
/** A row belongs to the card when its bright part spans at least this share of the width. */
const ROW_SPAN = 0.4;
/** Gaps in the card rows up to this share of the height are bridged (glare, a dark photo band). */
const ROW_GAP = 0.03;
/** How far in from the found top or bottom (share of the card height) a sharper edge is looked for. */
const EDGE_REACH = 0.3;
/** A brightness step this large (0 to 255) is a card edge. */
const EDGE_STEP = 35;
/** The card must cover at least this share of the photo, else the finder gave up. */
const MIN_CARD_AREA = 0.15;
/** Space kept around the card, as a share of the photo side. */
export const CARD_MARGIN = 0.03;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Threshold between the dark and bright parts of a grey picture (Otsu). */
function otsu(hist: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      t = i;
    }
  }
  return t;
}

/**
 * The card as the bright rectangle on a darker table, in fractions of a grey
 * picture (one byte a pixel), or null when there is no clear card (the photo
 * is all card, or the table is as bright as the card).
 * How: the table's brightness is the middle of the outer ring; a pixel is
 * card when clearly brighter. A row is a card row when its bright pixels
 * span much of the width (card borders are bright even when the picture on
 * the card is dark). The longest run of card rows, small gaps bridged, gives
 * top and bottom; the middle of the rows' left and right ends gives the sides.
 */
export function findCardInGrey(data: Uint8Array | Buffer, width: number, height: number): Box | null {
  if (width < 16 || height < 16 || data.length < width * height) return null;
  const k = Math.max(2, Math.round(0.03 * Math.min(width, height)));
  const ring: number[] = [];
  const hist = new Array<number>(256).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      hist[v]++;
      if (y < k || y >= height - k || x < k || x >= width - k) ring.push(v);
    }
  }
  ring.sort((a, b) => a - b);
  const table = ring[Math.floor(ring.length / 2)];
  // A bright table (or a photo that is all card) has no dark frame to find.
  if (table > 150) return null;
  const t = Math.min(otsu(hist, width * height), table + 40);
  const bright = (x: number, y: number) => data[y * width + x] > t;
  const rows: { first: number; last: number }[] = [];
  for (let y = 0; y < height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width - 1; x++) {
      if (bright(x, y) && bright(x + 1, y)) {
        if (first < 0) first = x;
        last = x + 1;
      }
    }
    rows.push({ first, last });
  }
  const isCardRow = (y: number) => rows[y].first >= 0 && rows[y].last - rows[y].first > ROW_SPAN * width;
  const maxGap = Math.round(ROW_GAP * height);
  let bestStart = 0;
  let bestLen = 0;
  let start = -1;
  let lastCard = -1;
  for (let y = 0; y <= height; y++) {
    const ok = y < height && isCardRow(y);
    if (ok) {
      if (start < 0 || y - lastCard - 1 > maxGap) start = y;
      lastCard = y;
      if (lastCard - start + 1 > bestLen) {
        bestLen = lastCard - start + 1;
        bestStart = start;
      }
    }
  }
  if (bestLen === 0) return null;
  // Card rows from top to bottom: the photo is all card (or all table).
  if (bestLen >= (1 - 2 * ROW_GAP) * height) return null;
  const chosen = rows.slice(bestStart, bestStart + bestLen).filter((r) => r.first >= 0 && r.last - r.first > ROW_SPAN * width);
  const middle = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const x0 = middle(chosen.map((r) => r.first));
  const x1 = middle(chosen.map((r) => r.last)) + 1;
  // Glare on the table next to the card can pass for card rows. The card's
  // edge is a sharp step in brightness, glare is not: move the top or bottom
  // in to the strongest step near it, when there is a clear one.
  const mean = (y: number) => {
    let sum = 0;
    for (let x = x0; x < x1; x++) sum += data[y * width + x];
    return sum / Math.max(1, x1 - x0);
  };
  const m = Array.from({ length: height }, (_, y) => mean(y));
  const avg = (a: number, b: number) => {
    let sum = 0;
    for (let y = a; y <= b; y++) sum += m[y];
    return sum / (b - a + 1);
  };
  let top = bestStart;
  let bottom = bestStart + bestLen;
  const reach = Math.round(EDGE_REACH * bestLen);
  let bestStep = EDGE_STEP;
  for (let y = Math.max(3, bestStart + 2); y <= Math.min(height - 3, bestStart + reach); y++) {
    const step = avg(y, y + 2) - avg(y - 3, y - 1);
    if (step > bestStep) {
      bestStep = step;
      top = y;
    }
  }
  bestStep = EDGE_STEP;
  for (let y = Math.min(height - 4, bottom - 3); y >= Math.max(2, bottom - reach); y--) {
    const step = avg(y - 2, y) - avg(y + 1, y + 3);
    if (step > bestStep) {
      bestStep = step;
      bottom = y + 1;
    }
  }
  const box = { x: x0 / width, y: top / height, w: (x1 - x0) / width, h: (bottom - top) / height };
  if (box.w * box.h < MIN_CARD_AREA) return null;
  return box;
}

/** Finds the card in a photo (already turned by its camera setting). */
export async function findCard(image: Buffer): Promise<Box | null> {
  const { data, info } = await sharp(image, DECODE_OPTIONS)
    .resize(FIND_EDGE, FIND_EDGE, { fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return findCardInGrey(data, info.width, info.height);
}

/** The smallest box holding all the given boxes, or null for none. */
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A box grown by `margin` on every side, kept inside the picture. */
export function grow(b: Box, margin: number): Box {
  const x0 = clamp01(b.x - margin);
  const y0 = clamp01(b.y - margin);
  const x1 = clamp01(b.x + b.w + margin);
  const y1 = clamp01(b.y + b.h + margin);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Where to crop: the card found on the table, grown so no read text is cut
 * off (the finder may miss a glared edge), with a small margin. With no card
 * found there is no crop: cut to the text alone, a lone name line would sit
 * at the top of the picture, and where text sits on the card is a clue.
 */
export function cropBox(card: Box | null, textBoxes: Box[]): Box | null {
  if (!card) return null;
  const text = unionBox(textBoxes);
  return grow(text ? unionBox([card, text])! : card, CARD_MARGIN);
}

/** Where a box of a cropped part sits in the whole picture. */
export function mapBox(inPart: Box, part: Box): Box {
  return { x: part.x + inPart.x * part.w, y: part.y + inPart.y * part.h, w: inPart.w * part.w, h: inPart.h * part.h };
}

/** Where a box of the whole picture sits in a cropped part (may fall outside 0 to 1). */
export function unmapBox(b: Box, part: Box): Box {
  return { x: (b.x - part.x) / part.w, y: (b.y - part.y) / part.h, w: b.w / part.w, h: b.h / part.h };
}

/**
 * Where a box of the photo sits on the card picture: cut to `region` (when
 * given), then turned `turn` degrees clockwise. Null when it falls off the card.
 */
export function toView(b: Box, region: Box | undefined, turn: 0 | 90 | 270): Box | null {
  let r = region ? unmapBox(b, region) : b;
  if (turn === 90) r = { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  else if (turn === 270) r = { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  const x0 = clamp01(r.x);
  const y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w);
  const y1 = clamp01(r.y + r.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Share of box `a` that lies inside box `b`. */
export function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || a.w * a.h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

// ---------------------------------------------------------------------------
// Corners

/** Width and height of a corner part, as shares of the card. */
export const CORNER_W = 0.3;
export const CORNER_H = 0.2;

/** The four corners of an upright card, top left first. Card numbers sit in one of them. */
export function cornerBoxes(): Box[] {
  return [
    { x: 0, y: 0, w: CORNER_W, h: CORNER_H },
    { x: 1 - CORNER_W, y: 0, w: CORNER_W, h: CORNER_H },
    { x: 0, y: 1 - CORNER_H, w: CORNER_W, h: CORNER_H },
    { x: 1 - CORNER_W, y: 1 - CORNER_H, w: CORNER_W, h: CORNER_H },
  ];
}

/** Longest text kept from a corner read: a card number and a letter or two, not a cut line. */
export const CORNER_MAX_CHARS = 6;

/**
 * True when a line read in a corner part may be kept: short, and not touching
 * any edge of the part. A line running out of the part was cut, and one at
 * the photo's own edge may be cut too (a card number half out of the photo).
 */
export function keepCornerLine(text: string, box: Box): boolean {
  const plain = text.replace(/\s+/g, "");
  if (plain.length === 0 || plain.length > CORNER_MAX_CHARS) return false;
  const edge = 0.02;
  return box.x >= edge && box.y >= edge && box.x + box.w <= 1 - edge && box.y + box.h <= 1 - edge;
}

// ---------------------------------------------------------------------------
// Spaced letters

type Boxed = { text: string; box: Box };

/** "D O N R U S S" or "1 9 9 2": three or more single letters or digits with spaces. */
const SPACED_RUN = /(?:^|\s)(?:[\p{L}\p{N}]\s){2,}[\p{L}\p{N}](?=\s|$)/u;

/** Letters per height in a box: text set with wide spacing has few. */
function charsPerHeight(l: Boxed, aspect: number): number {
  const chars = l.text.replace(/\s+/g, "").length;
  const w = l.box.w * aspect;
  return l.box.h > 0 ? chars / (w / l.box.h) : Infinity;
}

/**
 * Rows of spaced letters, as bands across the picture (fractions), at most
 * `max`. A row is either one box whose text is single letters with spaces, a
 * box much wider than its letters need (letter spaced print), or three or
 * more boxes of one character each sitting side by side on one line (the
 * reader cut a spaced word into letters). `aspect` is width over height of
 * the picture, so box shapes can be compared in real proportions.
 */
export function spacedBands(lines: Boxed[], aspect: number, max = 2): Box[] {
  const rows: Box[] = [];
  const singles = lines.filter((l) => l.text.replace(/\s+/g, "").length === 1 && l.box.h > 0);
  for (const l of lines) {
    const chars = l.text.replace(/\s+/g, "").length;
    if (chars < 3) continue;
    // Printed capitals are about 0.7 of their height wide; spaced ones more than twice that.
    if (SPACED_RUN.test(l.text) || charsPerHeight(l, aspect) < 0.4) rows.push(l.box);
  }
  const used = new Set<Boxed>();
  const sameRow = (a: Box, b: Box) => Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < Math.min(a.h, b.h) * 0.5;
  for (const s of singles) {
    if (used.has(s)) continue;
    const row = singles.filter((o) => !used.has(o) && sameRow(o.box, s.box) && o.box.h < s.box.h * 1.6 && o.box.h > s.box.h / 1.6);
    if (row.length < 2 || !row.some((o) => /\p{L}/u.test(o.text))) continue;
    for (const o of row) used.add(o);
    const u = unionBox(row.map((o) => o.box))!;
    // A stat table header ("G AB R H 2B") has longer words between its single letters.
    const between = lines.some((o) => o.text.replace(/\s+/g, "").length > 1 && sameRow(o.box, s.box) && o.box.x > u.x && o.box.x + o.box.w < u.x + u.w);
    if (!between) rows.push(u);
  }
  const bands: Box[] = [];
  for (const r of rows) {
    const pad = r.h * 0.6;
    const band = { x: 0, y: clamp01(r.y - pad), w: 1, h: Math.min(1, r.y + r.h + pad) - clamp01(r.y - pad) };
    if (bands.some((b) => overlapShare(band, b) > 0.5)) continue;
    bands.push(band);
    if (bands.length >= max) break;
  }
  return bands;
}

/**
 * Joins runs of single letters on one line ("D O N R U S S 1 9 9 2" gives
 * "DONRUSS 1992"). A run of single digits is joined only as a year and only
 * on a line where letters were joined too, so stat rows ("3 6 2 2") stay.
 */
export function joinSpacedLetters(text: string): string {
  let joined = false;
  let out = text.replace(/(?<![\p{L}\p{N}])(?:\p{L} ){2,}\p{L}(?![\p{L}\p{N}])/gu, (m) => {
    joined = true;
    return m.replace(/ /g, "");
  });
  if (joined) out = out.replace(/(?<!\d)([12]) (\d) (\d) (\d)(?!\d)/g, (m, a, b, c, d) => {
    const y = `${a}${b}${c}${d}`;
    return /^(?:19|20)\d\d$/.test(y) ? y : m;
  });
  return out;
}
