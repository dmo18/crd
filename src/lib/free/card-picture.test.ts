import { describe, expect, it } from "vitest";
import {
  cornerBoxes, cropBox, findCardInGrey, joinSpacedLetters, keepCornerLine, mapBox, spacedBands, toView, unmapBox,
} from "./card-picture";

/** A grey picture: a dark table with a bright card at the given pixel box. */
function table(w: number, h: number, card: { x: number; y: number; w: number; h: number }, opts: { tableGrey?: number; cardGrey?: number; glareRows?: number } = {}) {
  const data = new Uint8Array(w * h).fill(opts.tableGrey ?? 40);
  for (let y = card.y; y < card.y + card.h; y++) for (let x = card.x; x < card.x + card.w; x++) data[y * w + x] = opts.cardGrey ?? 220;
  // A dark photo in the middle of the card: the card's borders stay bright.
  for (let y = card.y + 10; y < card.y + card.h - 10; y++) for (let x = card.x + 8; x < card.x + card.w - 8; x++) data[y * w + x] = 70;
  // Soft glare on the table just above the card, as bright as the card at its bottom.
  for (let i = 0; i < (opts.glareRows ?? 0); i++) {
    const y = card.y - 1 - i;
    const v = Math.round(150 - (i * 100) / (opts.glareRows ?? 1));
    for (let x = 0; x < w; x++) data[y * w + x] = Math.max(data[y * w + x], v);
  }
  return data;
}

describe("findCardInGrey", () => {
  it("finds a bright card on a dark table, also with a dark picture on the card", () => {
    const box = findCardInGrey(table(100, 200, { x: 10, y: 40, w: 80, h: 112 }), 100, 200)!;
    expect(box.x).toBeCloseTo(0.1, 1);
    expect(box.y).toBeCloseTo(0.2, 1);
    expect(box.w).toBeCloseTo(0.8, 1);
    expect(box.h).toBeCloseTo(0.56, 1);
  });

  it("moves the top in to the card edge when glare on the table touches the card", () => {
    const box = findCardInGrey(table(100, 200, { x: 10, y: 50, w: 80, h: 112 }, { glareRows: 20 }), 100, 200)!;
    expect(box.y).toBeGreaterThan(0.22);
    expect(box.y).toBeLessThan(0.27);
  });

  it("gives up when the photo is all card or the table is as bright as the card", () => {
    expect(findCardInGrey(new Uint8Array(100 * 200).fill(210), 100, 200)).toBeNull();
    expect(findCardInGrey(table(100, 200, { x: 10, y: 40, w: 80, h: 112 }, { tableGrey: 200, cardGrey: 230 }), 100, 200)).toBeNull();
    expect(findCardInGrey(new Uint8Array(10), 100, 200)).toBeNull();
  });
});

describe("cropBox", () => {
  it("never cuts off text read outside the card found, and keeps a margin", () => {
    const crop = cropBox({ x: 0.1, y: 0.3, w: 0.8, h: 0.4 }, [{ x: 0.2, y: 0.85, w: 0.5, h: 0.05 }])!;
    expect(crop.y + crop.h).toBeGreaterThanOrEqual(0.9);
    expect(crop.y).toBeLessThan(0.3);
    expect(cropBox(null, [])).toBeNull();
    // No card found: no crop, so boxes keep their place on the photo.
    expect(cropBox(null, [{ x: 0.2, y: 0.85, w: 0.5, h: 0.05 }])).toBeNull();
  });
});

describe("box mapping", () => {
  it("maps a part's box onto the whole picture and back", () => {
    const part = { x: 0.2, y: 0.1, w: 0.5, h: 0.5 };
    const b = { x: 0.1, y: 0.2, w: 0.2, h: 0.1 };
    const whole = mapBox(b, part);
    expect(whole.x).toBeCloseTo(0.25);
    const back = unmapBox(whole, part);
    expect(back.y).toBeCloseTo(0.2);
  });

  it("turns boxes with the photo: a quarter turn clockwise puts the left edge on top", () => {
    const leftEdge = { x: 0, y: 0.4, w: 0.1, h: 0.2 };
    expect(toView(leftEdge, undefined, 90)).toEqual({ x: expect.closeTo(0.4), y: 0, w: expect.closeTo(0.2), h: expect.closeTo(0.1) });
    const t = toView(leftEdge, undefined, 270)!;
    expect(t.y).toBeCloseTo(0.9);
    expect(toView({ x: 0.95, y: 0.95, w: 0.04, h: 0.04 }, { x: 0, y: 0, w: 0.5, h: 0.5 }, 0)).toBeNull();
  });
});

describe("corner reads", () => {
  it("has four corners", () => {
    expect(cornerBoxes()).toHaveLength(4);
  });
  it("keeps a short number inside a corner part, not a line cut at an edge or a long text", () => {
    expect(keepCornerLine("65", { x: 0.2, y: 0.3, w: 0.2, h: 0.3 })).toBe(true);
    expect(keepCornerLine("65", { x: 0.85, y: 0.3, w: 0.15, h: 0.3 })).toBe(false);
    expect(keepCornerLine("336", { x: 0.3, y: 0.0, w: 0.2, h: 0.2 })).toBe(false);
    expect(keepCornerLine("CAREER HIGHLIGHTS", { x: 0.2, y: 0.3, w: 0.5, h: 0.3 })).toBe(false);
  });
});

describe("spacedBands", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  it("finds a row of single letters the reader cut out of a spaced word", () => {
    const bands = spacedBands([
      { text: "N", box: box(0.25, 0.08, 0.03, 0.02) },
      { text: "R", box: box(0.32, 0.08, 0.03, 0.02) },
      { text: "9", box: box(0.7, 0.081, 0.03, 0.02) },
      { text: "BOBMILACKI", box: box(0.24, 0.8, 0.52, 0.07) },
    ], 0.7);
    expect(bands).toHaveLength(1);
    expect(bands[0].x).toBe(0);
    expect(bands[0].w).toBe(1);
    expect(bands[0].y).toBeLessThan(0.08);
    expect(bands[0].y + bands[0].h).toBeGreaterThan(0.1);
  });

  it("finds a box of spaced letters, and a box far wider than its letters", () => {
    expect(spacedBands([{ text: "D O N R U S S", box: box(0.1, 0.1, 0.8, 0.03) }], 0.7)).toHaveLength(1);
    expect(spacedBands([{ text: "FLEER", box: box(0.05, 0.1, 0.9, 0.02) }], 0.7)).toHaveLength(1);
  });

  it("leaves a stat table header and plain words alone", () => {
    expect(spacedBands([
      { text: "G", box: box(0.29, 0.25, 0.02, 0.05) },
      { text: "AB", box: box(0.33, 0.25, 0.03, 0.05) },
      { text: "R", box: box(0.37, 0.25, 0.02, 0.05) },
      { text: "H", box: box(0.42, 0.25, 0.02, 0.05) },
    ], 2)).toHaveLength(0);
    expect(spacedBands([{ text: "TIM HARDAWAY", box: box(0.18, 0.8, 0.47, 0.03) }], 0.46)).toHaveLength(0);
    // Single digits of a stat row are not a spaced word.
    expect(spacedBands([
      { text: "3", box: box(0.5, 0.85, 0.02, 0.05) },
      { text: "6", box: box(0.56, 0.85, 0.02, 0.05) },
    ], 2)).toHaveLength(0);
  });
});

describe("joinSpacedLetters", () => {
  it("joins single letters, and a year after them", () => {
    expect(joinSpacedLetters("D O N R U S S 1 9 9 2")).toBe("DONRUSS 1992");
    expect(joinSpacedLetters("U S A")).toBe("USA");
  });
  it("leaves stat rows, initials with words and plain text alone", () => {
    expect(joinSpacedLetters("3 6 2 2 2 1")).toBe("3 6 2 2 2 1");
    expect(joinSpacedLetters("1 9 9 2")).toBe("1 9 9 2");
    expect(joinSpacedLetters("G AB R H")).toBe("G AB R H");
    expect(joinSpacedLetters("Ken Griffey, Jr.")).toBe("Ken Griffey, Jr.");
  });
});
