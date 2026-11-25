import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { multiPhotos, recordedMulti } from "../../../tests/helpers/ocr-fixture";
import { REVIEW_THRESHOLD, type RecognitionPhoto } from "@/lib/recognition/types";
import type { CardShape } from "./find-cards";
import { looksLikeBack, ONE_SIDE_NOTE, pairScore, pairSides, type SideRead } from "./multi";
import type { OcrLine, OcrResult, ReadOptions, TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";

/**
 * Many cards in one photo (12R.7) on the owner's real try, replayed from the
 * real reader's recorded output (tests/fixtures/real-cards/multi.ocr.json,
 * made by multi.integration.test.ts), and on made-up text for the pairing
 * rules. No Python needed.
 */

const recording = recordedMulti();

/** A reader that gives the recorded reads in the order the cards are read, asking backIf as the real one does. */
function replay(reads: (OcrResult | null)[]): TextReader {
  let n = 0;
  return {
    async read(_image: Buffer, options?: ReadOptions): Promise<OcrResult> {
      const r = reads[n++] ?? { text: "", lines: [], confidence: 0 };
      options?.backIf?.(r);
      return r;
    },
  };
}

/** Runs the recognizer on the owner's two photos with the recorded cards, keeping only the cards picked per photo. */
async function owner(keep: number[][] = [[0, 1], [0, 1]], photoCount = 2) {
  const photos = (await multiPhotos()).slice(0, photoCount);
  const shapes = recording.shapes.map((s, p) => keep[p].map((k) => s[k]));
  const reads = recording.shapes.flatMap((s, p) => keep[p].map((k) => recording.reads[recording.shapes.slice(0, p).reduce((t, x) => t + x.length, 0) + k]));
  const r = new FreeRecognizer({
    reader: replay(reads.slice(0, shapes.slice(0, photoCount).flat().length)),
    findShapes: async (image) => shapes[photos.findIndex((p) => p.data === image)] ?? [],
    lookup: async () => null,
  });
  return r.recognize({ mode: "multi", photos });
}

describe("the owner's many-cards try, recorded", () => {
  it("found two cards in each photo and tells the backs from the fronts", () => {
    expect(recording.shapes.map((s) => s.length)).toEqual([2, 2]);
    expect(recording.reads.map(looksLikeBack)).toEqual([false, false, true, true]);
  });

  it("each card was read on its own: no text of the card beside it", () => {
    const [millsFront, hardawayFront, millsBack, hardawayBack] = recording.reads.map((r) => r.text.toUpperCase());
    for (const t of [millsFront, millsBack]) expect(t).not.toMatch(/HARDAWAY|FLEER|WARRIOR/);
    for (const t of [hardawayFront, hardawayBack]) expect(t).not.toMatch(/MILLS|OLYMPIC|IMPEL/);
  });

  it("pairs each front with its own back", () => {
    const sides: SideRead[] = recording.reads.map((text, i) => ({ photo: i < 2 ? 0 : 1, text, back: looksLikeBack(text) }));
    expect(pairSides(sides)).toEqual([[0, 2], [1, 3]]);
  });

  it("gives two cards, each read with both sides, nothing wrong", async () => {
    const items = await owner();
    expect(items).toHaveLength(2);
    const [mills, hardaway] = items;
    expect(mills).toMatchObject({ player: "Billy Mills", cardNumber: "24", sport: "other", team: null, sourceIndex: 0 });
    expect([null, 1991]).toContain(mills.year);
    expect([null, "Impel"]).toContain(mills.brand);
    expect(hardaway).toMatchObject({ player: "Tim Hardaway", year: 1993, brand: "Fleer", cardNumber: "65", sport: "basketball", sourceIndex: 0 });
    expect([null, "Golden State Warriors"]).toContain(hardaway.team);
    expect(mills.backPhoto).toEqual({ sourceIndex: 1, box: recording.shapes[1][0].box });
    expect(hardaway.backPhoto).toEqual({ sourceIndex: 1, box: recording.shapes[1][1].box });
    for (const card of items) {
      expect(card.notes).not.toContain(ONE_SIDE_NOTE);
      // Not every field is read in two places: the owner checks them.
      expect(card.confidence).toBeLessThan(REVIEW_THRESHOLD);
    }
  });

  it("each side records its cut-out, and a paired back is read again as a back, enlarged, kept only when better (review fixes 3 and 4)", async () => {
    const photos = await multiPhotos();
    const shapes = recording.shapes;
    const sizes: number[] = [];
    const seen: (ReadOptions | undefined)[] = [];
    const reads = [...recording.reads];
    const millsAgain: OcrResult = {
      ...recording.reads[2], lines: [...recording.reads[2].lines, { text: "\u00a91991 IMPEL MARKETING, INC.", confidence: 0.95, box: { x: 0.05, y: 0.93, w: 0.4, h: 0.02 } }],
    };
    millsAgain.text = millsAgain.lines.map((l) => l.text).join("\n");
    let n = 0;
    const r = new FreeRecognizer({
      reader: {
        async read(image, options) {
          sizes.push(Math.max((await sharp(image).metadata()).width ?? 0, (await sharp(image).metadata()).height ?? 0));
          seen.push(options);
          // 4 first reads, then the Mills back again (with its copyright line), then the Hardaway back again (nothing).
          const out = n < 4 ? reads[n] : n === 4 ? millsAgain : { text: "", lines: [], confidence: 0 };
          n++;
          options?.backIf?.(out);
          return out;
        },
      },
      findShapes: async (image) => shapes[photos.findIndex((p) => p.data === image)] ?? [],
      lookup: async () => null,
    });
    const [mills, hardaway] = await r.recognize({ mode: "multi", photos });
    expect(n).toBe(6);
    expect(seen.slice(4).every((o) => o?.back === true)).toBe(true);
    // Enlarged to the size a one card photo is read at.
    expect(Math.min(...sizes.slice(4))).toBeGreaterThanOrEqual(1500);
    expect(Math.max(...sizes.slice(0, 4))).toBeLessThan(1000);
    expect(mills).toMatchObject({ player: "Billy Mills", year: 1991, brand: "Impel", cardNumber: "24" });
    expect(hardaway).toMatchObject({ player: "Tim Hardaway", year: 1993, brand: "Fleer", cardNumber: "65" });
    for (const card of [mills, hardaway]) {
      expect(card.cuts?.front?.box).toEqual(card.box);
      expect(card.cuts?.back?.box).toEqual(card.backPhoto?.box);
    }
  });

  it("a front whose back was not found waits for the owner with a note", async () => {
    // The backs photo without the Hardaway back.
    const items = await owner([[0, 1], [0]]);
    expect(items).toHaveLength(2);
    const hardaway = items[1];
    expect(hardaway.backPhoto).toBeUndefined();
    expect(hardaway.notes).toContain(ONE_SIDE_NOTE);
    expect(hardaway.notes).not.toContain("Add a photo of the back");
    expect(hardaway.confidence).toBeLessThan(REVIEW_THRESHOLD);
    expect(items[0].backPhoto?.sourceIndex).toBe(1);
  });

  it("a side left without its partner carries the one side hold, so a catalog link never files it alone", async () => {
    const items = await owner([[0, 1], [0]]);
    expect(items[1].evidence?.hold).toContain("one_side");
    expect(items[0].evidence?.hold ?? []).not.toContain("one_side");
  });

  it("a back whose front was not found is a card with its name, never guessed as baseball, with a note", async () => {
    // The fronts photo without the Mills front.
    const items = await owner([[1], [0, 1]]);
    expect(items).toHaveLength(2);
    const [hardaway, millsBack] = items;
    expect(hardaway.player).toBe("Tim Hardaway");
    expect(millsBack).toMatchObject({ player: "William Mervin Mills", cardNumber: "24", sourceIndex: 1 });
    expect(millsBack.sport).not.toBe("baseball");
    expect(millsBack.notes).toContain(ONE_SIDE_NOTE);
    expect(millsBack.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it("a front only scan reads each front as before: no pairing, no one side note", async () => {
    const items = await owner([[0, 1], []], 1);
    expect(items.map((i) => i.player)).toEqual(["Billy Mills", null]);
    for (const card of items) {
      expect(card.notes).not.toContain(ONE_SIDE_NOTE);
      expect(card.backPhoto).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Made-up cards

type L = [text: string, y: number, h?: number];

function ocr(lines: L[]): OcrResult {
  const out: OcrLine[] = lines.map(([text, y, h = 0.03]) => ({ text, confidence: 0.95, box: { x: 0.08, y, w: 0.8, h } }));
  return { text: out.map((l) => l.text).join("\n"), lines: out, confidence: 0.95 };
}

function front(name: string, team: string): OcrResult {
  return ocr([[name, 0.82, 0.06], [team, 0.9, 0.04]]);
}

/** A back: the name in large type at the top, a short life story, a copyright line. */
function back(heading: string, story: string, maker = "© 1990 THE TOPPS COMPANY, INC."): OcrResult {
  return ocr([
    [heading, 0.05, 0.06],
    ["HEIGHT: 6'3\" WEIGHT: 195 BORN: 11/21/69", 0.15],
    [story, 0.3],
    ["and he was named to the league all star team in his second season.", 0.34],
    ["He led his club in hits and runs that year as well.", 0.38],
    [maker, 0.92],
  ]);
}

const side = (photo: number, text: OcrResult, isBack: boolean): SideRead => ({ photo, text, back: isBack });

describe("pairing fronts and backs (made-up cards)", () => {
  it("pairs three fronts with three backs laid out in another order", () => {
    const sides = [
      side(0, front("KEN GRIFFEY JR.", "MARINERS"), false),
      side(0, front("FRANK THOMAS", "WHITE SOX"), false),
      side(0, front("BO JACKSON", "ROYALS"), false),
      side(1, back("BO JACKSON", "Jackson hit 32 home runs in his first full season"), true),
      side(1, back("KEN GRIFFEY JR.", "Ken was the first pick of the 1987 draft"), true),
      side(1, back("FRANK THOMAS", "Thomas set a club record for walks"), true),
    ];
    for (const s of sides) expect(looksLikeBack(s.text)).toBe(s.back);
    expect(pairSides(sides)).toEqual([[0, 4], [1, 5], [2, 3]]);
  });

  it("a surname only in another player's story is no pair; the front's given name with it, or the back's own name, is", () => {
    const thomas = side(0, front("FRANK THOMAS", "WHITE SOX"), false);
    // The back's heading is not read; its story mentions Thomas once.
    const story = (text: string) => ocr([
      ["HEIGHT: 6'1\" WEIGHT: 190 BORN: 4/5/66", 0.15],
      [text, 0.3],
      ["and he was named to the league all star team in his second season.", 0.34],
      ["He led his club in hits and runs that year as well.", 0.38],
      ["© 1990 THE TOPPS COMPANY, INC.", 0.92],
    ]);
    const other = side(1, story("He and Thomas shared first base in the minors"), true);
    expect(looksLikeBack(other.text)).toBe(true);
    expect(pairScore(thomas, other)).toBe(0);
    expect(pairSides([thomas, other])).toEqual([]);
    const own = side(1, story("Frank Thomas set a club record for walks"), true);
    expect(pairScore(thomas, own)).toBeGreaterThan(0);
    expect(pairSides([thomas, own])).toEqual([[0, 1]]);
  });

  it("two players sharing a surname are told apart by the given name, and not paired when nothing tells them apart", () => {
    const fronts = [side(0, front("TONY GWYNN", "PADRES"), false), side(0, front("CHRIS GWYNN", "DODGERS"), false)];
    const named = [
      side(1, back("CHRIS GWYNN", "Gwynn was a first round pick in 1985"), true),
      side(1, back("TONY GWYNN", "Gwynn won the batting title"), true),
    ];
    expect(pairSides([...fronts, ...named])).toEqual([[0, 3], [1, 2]]);
    // Backs that show only the surname: either back fits either front equally, so none is paired.
    const surnameOnly = [
      side(1, back("GWYNN", "Gwynn was a first round pick in 1985"), true),
      side(1, back("GWYNN", "Gwynn won the batting title"), true),
    ];
    expect(pairSides([...fronts, ...surnameOnly])).toEqual([]);
  });

  it("never pairs a front and a back of different players, or two sides of one photo", () => {
    const sides = [
      side(0, front("FRANK THOMAS", "WHITE SOX"), false),
      side(0, back("FRANK THOMAS", "Thomas set a club record for walks"), true),
      side(1, back("BO JACKSON", "Jackson hit 32 home runs"), true),
    ];
    expect(pairSides(sides)).toEqual([]);
  });

  it("a back naming another player is never paired, even when its story uses the front's surname", () => {
    const sides = [
      side(0, front("FRANK THOMAS", "WHITE SOX"), false),
      side(1, back("DAN PASQUA", "Pasqua and Thomas shared first base"), true),
    ];
    expect(pairSides(sides)).toEqual([]);
  });

  it("a maker that disagrees outweighs a surname read only in the story", () => {
    const sides = [
      side(0, ocr([["1990 TOPPS", 0.05, 0.05], ["FRANK THOMAS", 0.82, 0.06]]), false),
      side(1, ocr([["Thomas set a club record for walks and hit .330 that year", 0.3], ["© 1991 SCORE", 0.92], ["HEIGHT: 6'5\" BORN: 5/27/68", 0.2]]), true),
    ];
    expect(looksLikeBack(sides[1].text)).toBe(true);
    expect(pairSides(sides)).toEqual([]);
  });

  it("a back with no front in the scan stays alone", () => {
    const sides = [
      side(0, front("FRANK THOMAS", "WHITE SOX"), false),
      side(1, back("FRANK THOMAS", "Thomas set a club record for walks"), true),
      side(1, back("BO JACKSON", "Jackson hit 32 home runs"), true),
    ];
    expect(pairSides(sides)).toEqual([[0, 1]]);
  });
});

describe("each card is read on its own", () => {
  it("blanks everything outside a turned card's own outline before reading it", async () => {
    // A white card turned on a green table, with a red card's corner inside its box.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">
      <rect width="100%" height="100%" fill="#2a6a3a"/>
      <rect x="0" y="0" width="160" height="160" fill="#d02020"/>
      <rect x="300" y="200" width="400" height="560" fill="#ffffff" transform="rotate(20 500 480)"/>
    </svg>`;
    const data = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
    const photo: RecognitionPhoto = { role: "source", data, width: 1000, height: 1000 };
    const rad = (20 * Math.PI) / 180;
    const outline = ([[300, 200], [700, 200], [700, 760], [300, 760]] as [number, number][]).map(([x, y]): [number, number] => {
      const dx = x - 500;
      const dy = y - 480;
      return [(500 + dx * Math.cos(rad) - dy * Math.sin(rad)) / 1000, (480 + dx * Math.sin(rad) + dy * Math.cos(rad)) / 1000];
    });
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    const box = { x: 0.1, y: 0.1, w: Math.max(...xs) - 0.1, h: Math.max(...ys) - 0.1 };
    const shape: CardShape = { box, outline };
    const seen: Buffer[] = [];
    const r = new FreeRecognizer({
      reader: { read: async (image) => { seen.push(image); return { text: "", lines: [], confidence: 0 }; } },
      findShapes: async () => [shape],
      tilt: async () => 0,
      lookup: async () => null,
    });
    await r.recognize({ mode: "multi", photos: [photo] });
    const { data: px, info } = await sharp(seen[0]).raw().toBuffer({ resolveWithObject: true });
    const at = (fx: number, fy: number) => {
      const i = (Math.floor(fy * (info.height - 1)) * info.width + Math.floor(fx * (info.width - 1))) * info.channels;
      return [px[i], px[i + 1], px[i + 2]];
    };
    // The red corner of the neighbour, top left of the box, is painted plain grey.
    const corner = at(0.02, 0.02);
    expect(Math.abs(corner[0] - corner[1])).toBeLessThan(12);
    expect(corner[0]).toBeLessThan(90);
    // The card itself is kept.
    expect(at(0.55, 0.55).every((v) => v > 220)).toBe(true);
  });
});

describe("rules met on the owner's try (12R.7)", () => {
  it("a front name read without its space and first name takes the back's large name with that surname, unsure", async () => {
    const { parseCardText } = await import("./parse");
    const f = ocr([["NMHARDAWAY", 0.82, 0.05], ["WARRIORS G", 0.9, 0.04]]);
    const b = ocr([
      ["65", 0.1, 0.05], ["HEIGHT: 6'0\" WEIGHT: 175", 0.4], ["BORN: 9/1/66 CHICAGO", 0.45], ["COLLEGE: TEXAS-EL PASO", 0.5],
      ["TIM HARDAWAY", 0.7, 0.07], ["Year Club G FG% FT% REB AST", 0.8], ["© 1993 FLEER CORP.", 0.9],
    ]);
    const p = parseCardText(f, b);
    expect(p.player).toBe("Tim Hardaway");
    expect(p.certainty.player).toBe("unsure");
    // Not without the front: a back's name outside its heading is no name on its own.
    expect(parseCardText(ocr([["WARRIORS G", 0.9, 0.04]]), b).player).toBeNull();
  });

  it("the word Athletics alone never makes a card baseball", async () => {
    const { parseCardText } = await import("./parse");
    const back = ocr([["WILLIAM MERVIN MILLS", 0.05, 0.06], ["Athletics", 0.18], ["Class of 1984", 0.2], ["During the 1964 Tokyo Olympic Games he became the first", 0.3]]);
    expect(parseCardText(null, back).sport).toBeNull();
    // With its city it is the baseball team.
    expect(parseCardText(ocr([["MARK MCGWIRE", 0.82, 0.06], ["OAKLAND ATHLETICS", 0.9]]), null).sport).toBe("baseball");
  });
});
