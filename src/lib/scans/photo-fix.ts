import { grow, overlapShare } from "@/lib/free/card-picture";
import type { Box, ReadFix } from "@/lib/recognition/types";

/** The card must cover between these shares of the photo to be cut out. */
export const MIN_CARD_SHARE = 0.2;
export const MAX_CARD_SHARE = 0.95;
/** A card is 0.7 wide for 1 tall (a little tolerance around 0.6 to 0.8), or the other way round. */
const SHAPE_LOW = 0.55;
const SHAPE_HIGH = 0.85;
/** Space kept around the card, as a share of each side of the photo. */
export const FIX_MARGIN = 0.03;
/** A text line counts as inside the card when at least this share of it is. */
const LINE_INSIDE = 0.9;

export type FixPlan = { turn: 0 | 90 | 180 | 270; box: Box | null };

/**
 * What to do to a stored photo after reading (S1b). Turn only when the
 * direction is trusted. Cut only when the card box is trusted, covers 20 to
 * 95 percent of the photo, has the shape of a card and holds every text line
 * the reader used; the cut has a 3 percent margin. Null when nothing is to be done.
 */
export function planFix(fix: ReadFix, width: number, height: number): FixPlan | null {
  const turn = fix.turnTrusted ? fix.turn : 0;
  let box: Box | null = null;
  const c = fix.card;
  if (c && fix.cardTrusted && width > 0 && height > 0) {
    const share = c.w * c.h;
    const ratio = (c.w * width) / (c.h * height);
    // After a turn of 90 or 270 the card is judged in the shape it has now; shape either way is allowed.
    const cardLike = (ratio >= SHAPE_LOW && ratio <= SHAPE_HIGH) || (1 / ratio >= SHAPE_LOW && 1 / ratio <= SHAPE_HIGH);
    const holdsText = fix.lines.every((l) => overlapShare(l, c) >= LINE_INSIDE);
    if (share >= MIN_CARD_SHARE && share <= MAX_CARD_SHARE && cardLike && holdsText) box = grow(c, FIX_MARGIN);
  }
  return turn === 0 && !box ? null : { turn, box };
}
