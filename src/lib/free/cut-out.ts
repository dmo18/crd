import sharp from "sharp";
import type { Box } from "@/lib/recognition/types";

/**
 * One card cut out of a photo of several cards (12R.7), the same way for
 * reading and for the stored picture: its upright box, everything outside
 * the card's own outline painted plain (a turned card does not fill its box,
 * and the card beside it must never show), then turned by its tilt so the
 * text runs straight. Pure picture work; the same inputs give the same size.
 */
export type CardCut = {
  /** The card's upright box in the photo (fractions). */
  box: Box;
  /** The card's own outline in the photo (fractions), corner by corner. */
  outline: [number, number][];
  /** Degrees the cut-out was turned back to stand straight (0 when it was not). */
  tilt: number;
};

const DECODE_OPTIONS = { failOn: "error", limitInputPixels: 30_000_000 } as const;
/** Colour put where the photo is not this card: plain, like a dark table, with no text in it. */
export const CUT_BLANK = "#383838";
/** A little more than the found outline, so the card's own edge is never cut. */
const OUTLINE_GROW = 1.03;

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** The card's box cut from the photo, with everything outside its outline painted plain. PNG. */
export async function maskCard(data: Buffer, box: Box, outline: [number, number][]): Promise<Buffer> {
  const meta = await sharp(data, DECODE_OPTIONS).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.floor(clamp01(box.x) * W);
  const top = Math.floor(clamp01(box.y) * H);
  const width = Math.max(16, Math.min(W - left, Math.round(box.w * W)));
  const height = Math.max(16, Math.min(H - top, Math.round(box.h * H)));
  const crop = await sharp(data, DECODE_OPTIONS).extract({ left, top, width, height }).png({ compressionLevel: 1 }).toBuffer();
  const corners: [number, number][] = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
  const inBox = outline.length === 4 && outline.every(([x, y], k) => Math.abs(x - corners[k][0]) < 1e-6 && Math.abs(y - corners[k][1]) < 1e-6);
  if (inBox || outline.length < 3) return crop;
  const cx = outline.reduce((t, p) => t + p[0], 0) / outline.length;
  const cy = outline.reduce((t, p) => t + p[1], 0) / outline.length;
  const points = outline
    .map(([x, y]): [number, number] => [cx + (x - cx) * OUTLINE_GROW, cy + (y - cy) * OUTLINE_GROW])
    .map(([x, y]) => `${(((x - box.x) / box.w) * width).toFixed(1)},${(((y - box.y) / box.h) * height).toFixed(1)}`)
    .join(" ");
  const keep = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polygon points="${points}" fill="#fff"/></svg>`);
  const cut = await sharp(crop).ensureAlpha().composite([{ input: keep, blend: "dest-in" }]).png().toBuffer();
  return sharp(cut).flatten({ background: CUT_BLANK }).png({ compressionLevel: 1 }).toBuffer();
}

/** Turned back by its tilt (nothing when the tilt is 0), the new corners in `background`. PNG. */
export async function untilt(data: Buffer, tilt: number, background: string): Promise<Buffer> {
  if (!tilt) return data;
  return sharp(data, DECODE_OPTIONS).rotate(-tilt, { background }).png({ compressionLevel: 1 }).toBuffer();
}

/** The whole cut-out as stored: masked, then turned straight. PNG. */
export async function cutOutCard(data: Buffer, cut: CardCut): Promise<Buffer> {
  return untilt(await maskCard(data, cut.box, cut.outline), cut.tilt, CUT_BLANK);
}
