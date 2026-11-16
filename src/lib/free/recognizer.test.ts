import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { REVIEW_THRESHOLD, type RecognitionPhoto } from "@/lib/recognition/types";
import { closeTextReader, getTextReader, type OcrResult, type TextReader } from "./ocr";
import { FreeRecognizer } from "./recognizer";
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
    expect(item.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(item.estimate).toBeNull();
    expect(lookups).toBe(0);
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

describe("FreeRecognizer end to end with the real text reader", () => {
  afterAll(() => closeTextReader());
  it("reads a printed card back and identifies it", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400">
      <rect width="100%" height="100%" fill="#e9dfc4"/>
      <text x="70" y="140" font-family="sans-serif" font-size="64" font-weight="700" fill="#222">NO. 1</text>
      <text x="70" y="260" font-family="sans-serif" font-size="64" font-weight="700" fill="#222">KEN GRIFFEY JR.</text>
      <text x="70" y="340" font-family="sans-serif" font-size="40" fill="#222">SEATTLE MARINERS  OF</text>
      <text x="70" y="1300" font-family="sans-serif" font-size="32" fill="#222">© 1989 THE UPPER DECK CO.</text></svg>`);
    const data = await sharp(svg).jpeg({ quality: 90 }).toBuffer();
    const r = new FreeRecognizer({ reader: getTextReader(), lookup: async () => null });
    const [item] = await r.recognize({ mode: "single", photos: [{ role: "front", data, width: 1000, height: 1400 }] });
    expect(item).toMatchObject({ year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", rarityTier: "grail" });
    expect(item.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  }, 60000);
});
