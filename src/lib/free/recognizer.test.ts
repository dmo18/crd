import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { RecognitionError, REVIEW_THRESHOLD, type RecognitionPhoto } from "@/lib/recognition/types";
import { ReaderDownError, type OcrResult, type TextReader } from "./ocr";
import { FreeRecognizer, READER_DOWN } from "./recognizer";
import type { PlayerFacts } from "./wikidata";

/** A fake reader that returns set text per photo, keyed by the photo's first byte. */
function reader(texts: Record<number, string>): TextReader {
  return {
    async read(image: Buffer): Promise<OcrResult> {
      const text = texts[image[0]] ?? "";
      const lines = text.split("\n").filter(Boolean).map((t, i) => ({ text: t, confidence: 0.9, box: { x: 0.05, y: 0.05 + i * 0.08, w: 0.9, h: 0.06 } }));
      return { text, lines, confidence: lines.length ? 0.9 : 0 };
    },
  };
}
const photo = (id: number, role: RecognitionPhoto["role"] = "front"): RecognitionPhoto => ({ role, data: Buffer.from([id, 0, 0]), width: 1000, height: 1400 });

const thomasFacts: PlayerFacts = {
  name: "Frank Thomas", wikidataId: "Q1", description: "American baseball player", sports: ["baseball"],
  teams: ["Chicago White Sox"], careerStart: 1990, careerEnd: 2008, hallOfFame: true, birthYear: 1968,
};

describe("FreeRecognizer with fake parts", () => {
  it("matches a key card from the back of the card and skips the online lookup", async () => {
    let lookups = 0;
    const r = new FreeRecognizer({
      reader: reader({ 1: "FRANK THOMAS\nWHITE SOX", 2: "NO. 414\nFRANK THOMAS\nFIRST BASE\n© 1990 THE TOPPS COMPANY, INC." }),
      lookup: async () => { lookups++; return null; },
    });
    const [item] = await r.recognize({ mode: "single", photos: [photo(1), photo(2, "back")] });
    expect(item).toMatchObject({ kind: "card", year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas", isRookie: true });
    // Year and brand were each read in one place only (the copyright line):
    // a key card hit alone no longer files the card (12R.5 round 2).
    expect(item.confidence).toBeLessThan(REVIEW_THRESHOLD);
    expect(item.evidence?.certainty).toMatchObject({ year: "unsure", brand: "unsure" });
    expect(item.estimate).toBeNull();
    expect(lookups).toBe(0);
  });

  it("files a key card on its own only when player, year and brand are each read in two places", async () => {
    const r = new FreeRecognizer({
      reader: reader({ 1: "1990 TOPPS\nFRANK THOMAS\nWHITE SOX", 2: "FRANK THOMAS\nNO. 414\nFIRST BASE\n\u00a9 1990 THE TOPPS COMPANY, INC." }),
      lookup: async () => null,
    });
    const [item] = await r.recognize({ mode: "single", photos: [photo(1), photo(2, "back")] });
    expect(item).toMatchObject({ year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas", isRookie: true });
    expect(item.evidence?.certainty).toMatchObject({ year: "sure", brand: "sure", player: "sure" });
    expect(item.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it("confirms an unlisted player on Wikidata and notes Hall of Fame and possible rookie", async () => {
    const r = new FreeRecognizer({
      reader: reader({ 3: "NO. 99\nFRANK THOMAS\n© 1990 SCORE" }),
      lookup: async (name) => (name === "Frank Thomas" ? thomasFacts : null),
    });
    const [item] = await r.recognize({ mode: "single", photos: [photo(3)] });
    expect(item.player).toBe("Frank Thomas");
    expect(item.sport).toBe("baseball");
    expect(item.rarityTier).toBe("star");
    expect(item.rarityNotes).toMatch(/Hall of Fame/);
    expect(item.rarityNotes).toMatch(/may be a rookie card/);
    expect(item.isRookie).toBe(false);
    expect(item.notes).toMatch(/Wikidata/);
  });

  it("writes a team hint only when the player's Wikidata team list has it (10.10)", async () => {
    const text = "NO. 99\nFRANK THOMAS\nFrank was the White Sox top pick in the 1989 draft.\n© 1990 SCORE";
    const run = async (facts: PlayerFacts | null) => {
      const r = new FreeRecognizer({ reader: reader({ 3: text }), lookup: async () => facts });
      return (await r.recognize({ mode: "single", photos: [photo(3)] }))[0];
    };
    // The team stands only in a sentence: a hint.
    const none = await run(null);
    expect(none.team).toBeNull();
    expect(none.notes).toMatch(/Maybe team Chicago White Sox/);
    const confirmed = await run(thomasFacts);
    expect(confirmed.team).toBe("Chicago White Sox");
    expect(confirmed.notes).toMatch(/Team confirmed on Wikidata: Chicago White Sox/);
    // A team list without it, or another sport: not written.
    expect((await run({ ...thomasFacts, teams: ["Oakland Athletics"] })).team).toBeNull();
    expect((await run({ ...thomasFacts, sports: ["football"] })).team).toBeNull();
  });

  it("H1 end to end: a lowercase bio word and a misread front team write no team", async () => {
    const r = new FreeRecognizer({
      reader: reader({ 1: "GREGG OLSON\nMARMNERS", 2: "NO. 723\nHis two sons are twins and both play ball.\n© 1989 THE UPPER DECK CO." }),
      lookup: async () => ({ ...thomasFacts, name: "Gregg Olson", teams: ["Baltimore Orioles"] }),
    });
    const [item] = await r.recognize({ mode: "single", photos: [photo(1), photo(2, "back")] });
    expect(item.team).toBeNull();
    expect(item.notes).not.toMatch(/Twins/);
  });

  it("a key card looks the player up only to check a team hint", async () => {
    let lookups = 0;
    const r = new FreeRecognizer({
      reader: reader({ 1: "FRANK THOMAS\nFrank was the White Sox top pick in the 1989 draft.", 2: "NO. 414\nFRANK THOMAS\nFIRST BASE\n© 1990 THE TOPPS COMPANY, INC." }),
      lookup: async () => { lookups++; return thomasFacts; },
    });
    const [item] = await r.recognize({ mode: "single", photos: [photo(1), photo(2, "back")] });
    expect(item).toMatchObject({ player: "Frank Thomas", cardNumber: "414", team: "Chicago White Sox", isRookie: true });
    expect(lookups).toBe(1);
  });

  it("still files a card it cannot read, for the owner to fill in", async () => {
    const r = new FreeRecognizer({ reader: reader({}), lookup: async () => null });
    const [item] = await r.recognize({ mode: "single", photos: [photo(9)] });
    expect(item.kind).toBe("card");
    expect(item.confidence).toBeLessThan(REVIEW_THRESHOLD);
    expect(item.notes).toMatch(/Could not read/);
  });

  it("never fails a scan when the online lookup breaks", async () => {
    const r = new FreeRecognizer({ reader: reader({ 3: "NO. 99\nJOE SAMPLE\n© 1990 SCORE" }), lookup: async () => { throw new Error("down"); } });
    const [item] = await r.recognize({ mode: "single", photos: [photo(3)] });
    expect(item.year).toBe(1990);
    expect(item.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it("reads each card found in a many-card photo, or the whole photo when none are found", async () => {
    const source = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: "#225533" } }).jpeg().toBuffer();
    const boxes = [{ x: 0.05, y: 0.05, w: 0.4, h: 0.4 }, { x: 0.55, y: 0.05, w: 0.4, h: 0.4 }];
    const r = new FreeRecognizer({
      reader: { read: async () => ({ text: "", lines: [], confidence: 0 }) },
      findBoxes: async () => boxes,
      lookup: async () => null,
    });
    const items = await r.recognize({ mode: "multi", photos: [{ role: "source", data: source, width: 1000, height: 1400 }] });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.box)).toEqual(boxes);
    const none = new FreeRecognizer({ reader: reader({}), findBoxes: async () => [], lookup: async () => null });
    const whole = await none.recognize({ mode: "multi", photos: [{ role: "source", data: source, width: 1000, height: 1400 }] });
    expect(whole).toHaveLength(1);
    expect(whole[0].box).toBeNull();
  });

  it("straightens a tilted card crop before reading it", async () => {
    const source = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: "#225533" } }).jpeg().toBuffer();
    const sizes: { width?: number; height?: number }[] = [];
    const r = new FreeRecognizer({
      reader: { read: async (image) => { sizes.push(await sharp(image).metadata()); return { text: "", lines: [], confidence: 0 }; } },
      findBoxes: async () => [{ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, { x: 0.5, y: 0.5, w: 0.3, h: 0.4 }],
      tilt: async (image) => ((await sharp(image).metadata()).width === 400 ? 30 : 2),
      lookup: async () => null,
    });
    await r.recognize({ mode: "multi", photos: [{ role: "source", data: source, width: 1000, height: 1400 }] });
    // 400 x 560 turned 30 degrees needs a wider canvas; a 2 degree tilt is read as it is.
    expect(sizes[0].width).toBeGreaterThan(600);
    expect(sizes[1].width).toBe(300);
  });

  it("reads sealed product and bulk labels and suggests key cards to look for", async () => {
    const r = new FreeRecognizer({ reader: reader({ 5: "1990 TOPPS BASEBALL\n36 PACKS\nWAX BOX", 6: "1989 UPPER DECK\n800 COUNT" }), lookup: async () => null });
    const [sealed] = await r.recognize({ mode: "sealed", photos: [photo(5, "source")] });
    expect(sealed).toMatchObject({ kind: "sealed", year: 1990, brand: "Topps", packCount: 36, sealState: "unknown" });
    expect(sealed.pullList.some((p) => p.includes("Frank Thomas"))).toBe(true);
    const [bulk] = await r.recognize({ mode: "bulk", photos: [photo(6, "source")] });
    expect(bulk).toMatchObject({ kind: "bulk", year: 1989, estCount: 800 });
    expect(bulk.pullList.some((p) => p.includes("Griffey"))).toBe(true);
  });
});

describe("FreeRecognizer passes what it saw as evidence, not as fields", () => {
  const run = async (text: string) => {
    const r = new FreeRecognizer({ reader: reader({ 5: text }), lookup: async () => null });
    return (await r.recognize({ mode: "single", photos: [photo(5)] }))[0];
  };
  it("a key list hit is passed explicitly, and a card off the list has none", async () => {
    const hit = await run("NO. 414\nFRANK THOMAS\nFIRST BASE\n© 1990 THE TOPPS COMPANY, INC.");
    expect(hit.evidence?.keyCard).toEqual({ isRookie: true });
    const off = await run("NO. 99\nSOME PLAYER\n© 1990 SCORE");
    expect(off.evidence?.keyCard).toBeUndefined();
  });
  it("a read serial number travels as evidence with its line; the item field stays empty", async () => {
    const item = await run("NO. 414\nFRANK THOMAS\n045/100\n© 1995 THE TOPPS COMPANY, INC.");
    expect(item.serialNumber).toBeNull();
    expect(item.evidence?.serial).toMatchObject({ text: "045/100", line: "045/100", weak: false });
  });
  it("the word ROOKIE and REPRINT travel as evidence", async () => {
    const item = await run("NO. 414\nFRANK THOMAS\nROOKIE\nREPRINT\n© 1990 THE TOPPS COMPANY, INC.");
    expect(item.evidence).toMatchObject({ rookieWord: true, reprint: true });
  });
});

describe("FreeRecognizer when the text reader itself is not working (12R final review)", () => {
  const dead: TextReader = { read: async () => { throw new ReaderDownError(); } };
  const source = () => sharp({ create: { width: 1000, height: 1400, channels: 3, background: "#225533" } }).jpeg().toBuffer();

  it("fails a single card scan with a plain message instead of an empty card", async () => {
    const r = new FreeRecognizer({ reader: dead, lookup: async () => null });
    const err = await r.recognize({ mode: "single", photos: [photo(1), photo(2, "back")] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognitionError);
    expect((err as RecognitionError).userMessage).toBe(READER_DOWN);
    expect(READER_DOWN).toBe("The text reader is not working. Try again later.");
  });

  it("fails a many-card scan instead of making one empty card per box", async () => {
    let reads = 0;
    const r = new FreeRecognizer({
      reader: { read: async () => { reads++; throw new ReaderDownError(); } },
      findBoxes: async () => [{ x: 0.05, y: 0.05, w: 0.4, h: 0.4 }, { x: 0.55, y: 0.05, w: 0.4, h: 0.4 }],
      lookup: async () => null,
    });
    await expect(r.recognize({ mode: "multi", photos: [{ role: "source", data: await source(), width: 1000, height: 1400 }] })).rejects.toBeInstanceOf(RecognitionError);
    expect(reads).toBe(1);
    const whole = new FreeRecognizer({ reader: dead, findBoxes: async () => [], lookup: async () => null });
    await expect(whole.recognize({ mode: "multi", photos: [{ role: "source", data: await source(), width: 1000, height: 1400 }] })).rejects.toBeInstanceOf(RecognitionError);
  });

  it("fails a product scan", async () => {
    const r = new FreeRecognizer({ reader: dead, lookup: async () => null });
    await expect(r.recognize({ mode: "sealed", photos: [photo(5, "source")] })).rejects.toBeInstanceOf(RecognitionError);
  });

  it("a photo the reader simply could not read still gives an empty card to fill in", async () => {
    const r = new FreeRecognizer({ reader: { read: async () => { throw new Error("Could not read text from the photo."); } }, lookup: async () => null });
    const [item] = await r.recognize({ mode: "single", photos: [photo(1)] });
    expect(item.kind).toBe("card");
    expect(item.notes).toContain("Could not read the printed text clearly");
  });
});
