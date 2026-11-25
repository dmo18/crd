import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindResult } from "@/lib/catalog/find";
import type { LookupResult } from "@/lib/catalog/lookup";
import type { Candidate } from "@/lib/catalog/match";
import type { RecognitionPhoto, RecognizedItem } from "@/lib/recognition/types";
import { FakeCatalog } from "../../../tests/helpers/fake-catalog";
import type { OcrResult, TextReader } from "./ocr";

/**
 * The recognizer's catalog step with the look up replaced, so these tests
 * hold whatever the matching rule decides: only the public result of
 * lookupCard (a sure card or candidates) is used.
 */
const lookupCard = vi.fn<(...args: unknown[]) => Promise<FindResult>>();
vi.mock("@/lib/catalog/find", async (orig) => ({ ...(await orig<typeof import("@/lib/catalog/find")>()), findCard: (...a: unknown[]) => lookupCard(...a) }));
const { FreeRecognizer, catalogPart, AUTO_FILL_SURE } = await import("./recognizer");

function reader(text: string): TextReader {
  return {
    async read(): Promise<OcrResult> {
      const lines = text.split("\n").filter(Boolean).map((t, i) => ({ text: t, confidence: 0.9, box: { x: 0.05, y: 0.05 + i * 0.08, w: 0.9, h: 0.06 } }));
      return { text, lines, confidence: 0.9 };
    },
  };
}
const photo: RecognitionPhoto = { role: "front", data: Buffer.from([1]), width: 10, height: 10 };
const TEXT = "KEN GRIFFEY JR.\nOUTFIELD MARINERS\n© 1990 THE TOPPS COMPANY, INC. BASEBALL";
const card: Candidate = {
  source: "mycardfolio", sourceId: "551033", url: "https://mycardfolio.com/sports/baseball/topps/1990/base-set-9179/x", sourceSetId: "9179",
  verified: true, sport: "baseball", year: 1990, brand: "Topps", setName: null, cardNumber: "336", player: "Ken Griffey Jr.",
  otherPlayers: [], variation: null, tags: [], score: 3, why: "Number and name agree",
};
const result = (over: Partial<FindResult>): FindResult => ({ candidates: [], match: null, matches: 0, fills: [], notes: [], callsUsed: 1, stopped: null, ...over });
const old = (over: Partial<LookupResult>): LookupResult => ({ sure: null, sureBy: null, candidates: [], callsUsed: 1, stopped: null, ...over });
const without = (item: RecognizedItem) => {
  const rest = { ...item };
  delete rest.catalog;
  return rest;
};

async function run(deps: Record<string, unknown> = {}, text = TEXT) {
  const r = new FreeRecognizer({ reader: reader(text), lookup: async () => null, ...deps });
  return (await r.recognize({ mode: "single", photos: [photo] }))[0];
}

beforeEach(() => { lookupCard.mockReset(); });

describe("FreeRecognizer catalog step", () => {
  it("without a catalog makes no look up and adds no catalog part", async () => {
    const item = await run();
    expect(lookupCard).not.toHaveBeenCalled();
    expect(item.catalog).toBeUndefined();
  });

  it("looks the read card up in the background line with what was read, and leaves the fields as read", async () => {
    lookupCard.mockResolvedValue(result({ candidates: [card] }));
    const plain = await run();
    const item = await run({ catalog: new FakeCatalog() });
    const [read, line] = lookupCard.mock.calls[0];
    expect(read).toMatchObject({ year: 1990, brand: "Topps", sport: "baseball", cardNumber: null, player: "Ken Griffey Jr." });
    expect(line).toBe("background");
    expect(without(item)).toEqual(without(plain));
    expect(item.catalog).toEqual({ status: "candidates", candidates: [card] });
  });

  it("the old sure path stays off: with automatic filling switched on (off in the app), a sure answer becomes a sure card", () => {
    const r = old({ sure: card, sureBy: "number", candidates: [card] });
    expect(AUTO_FILL_SURE).toBe(false);
    expect(catalogPart(r, 0.7, true)).toEqual({ status: "sure", card, confidence: 0.75 });
    expect(catalogPart(r, 0.7)).toEqual({ status: "candidates", candidates: [card] });
  });

  it("exactly one verified match is passed on as matched (the scan links it); the fields stay as read", async () => {
    lookupCard.mockResolvedValue(result({ match: card, matches: 1, candidates: [card] }));
    const plain = await run();
    const item = await run({ catalog: new FakeCatalog() });
    expect(item.catalog).toEqual({ status: "matched", candidates: [card] });
    expect(without(item)).toEqual(without(plain));
  });

  it("a checklist fill writes only a blank field, marked unsure, with a note", async () => {
    lookupCard.mockResolvedValue(result({ fills: [{ field: "cardNumber", value: "336", sure: false }, { field: "player", value: "Someone Else", sure: true }], notes: ["Card number filled from the catalog's set list: 336. Check it."] }));
    const item = await run({ catalog: new FakeCatalog() });
    expect(item.cardNumber).toBe("336");
    expect(item.player).toBe("Ken Griffey Jr.");
    expect(item.evidence?.certainty?.cardNumber).toBe("unsure");
    expect(item.notes).toContain("set list: 336");
  });

  it("candidates only: kept as they came, the reading stands", async () => {
    lookupCard.mockResolvedValue(result({ candidates: [card, { ...card, sourceId: "551885", player: "Ken Griffey Sr." }] }));
    const item = await run({ catalog: new FakeCatalog() });
    expect(item.catalog).toMatchObject({ status: "candidates" });
    expect((item.catalog as { candidates: Candidate[] }).candidates.map((c) => c.sourceId)).toEqual(["551033", "551885"]);
  });

  it("nothing found, stopped, or a look up that throws never fails the reading", async () => {
    const plain = await run();
    lookupCard.mockResolvedValueOnce(result({}));
    expect((await run({ catalog: new FakeCatalog() })).catalog).toEqual({ status: "none" });
    lookupCard.mockResolvedValueOnce(result({ stopped: "paused" }));
    expect((await run({ catalog: new FakeCatalog() })).catalog).toEqual({ status: "not_checked", reason: "paused" });
    lookupCard.mockRejectedValueOnce(new Error("boom"));
    const broken = await run({ catalog: new FakeCatalog() });
    expect(broken.catalog).toEqual({ status: "not_checked", reason: "failed" });
    expect(without(broken)).toEqual(without(plain));
  });

  it("stops starting look ups when the scan's catalog time is used up", async () => {
    let t = 0;
    lookupCard.mockImplementation(async () => { t += 50_000; return result({}); });
    const r = new FreeRecognizer({
      reader: reader(TEXT), lookup: async () => null, catalog: new FakeCatalog(), catalogTimeMs: 60_000, clock: () => t,
      findBoxes: async () => [0, 1, 2].map((i) => ({ x: 0.3 * i, y: 0, w: 0.3, h: 1 })),
    });
    const many = await r.recognize({ mode: "multi", photos: [{ role: "source", data: await solid(), width: 600, height: 300 }] });
    expect(many.map((i) => i.catalog?.status)).toEqual(["none", "none", "not_checked"]);
    expect(many[2].catalog).toEqual({ status: "not_checked", reason: "time" });
    expect(lookupCard).toHaveBeenCalledTimes(2);
  });

  it("a look up slower than the time left is given up; the card shows not checked", async () => {
    lookupCard.mockImplementation(() => new Promise(() => undefined));
    const item = await run({ catalog: new FakeCatalog(), catalogTimeMs: 20 });
    expect(item.catalog).toEqual({ status: "not_checked", reason: "time" });
  });

  it("when the time runs out the look up in progress is stopped: later catalog calls are refused without a network call", async () => {
    const fake = new FakeCatalog();
    let used: import("@/lib/catalog/types").Catalog | undefined;
    lookupCard.mockImplementation((_r, _l, o) => { used = (o as { catalog: import("@/lib/catalog/types").Catalog }).catalog; return new Promise(() => undefined); });
    const item = await run({ catalog: fake, catalogTimeMs: 20 });
    expect(item.catalog).toEqual({ status: "not_checked", reason: "time" });
    const after = await used!.search({ text: "griffey" }, "background");
    expect(after).toMatchObject({ ok: false, reason: "busy" });
    expect(await used!.card("1", "background")).toMatchObject({ ok: false });
    expect(await used!.checklist("1", "background")).toMatchObject({ ok: false });
    expect(fake.calls).toEqual([]);
  });

  it("sealed and bulk scans make no look up; an unread card is not looked up", async () => {
    const r = new FreeRecognizer({ reader: reader("1990 TOPPS BASEBALL\n36 PACKS\nWAX BOX"), lookup: async () => null, catalog: new FakeCatalog() });
    await r.recognize({ mode: "sealed", photos: [{ ...photo, role: "source" }] });
    await r.recognize({ mode: "bulk", photos: [{ ...photo, role: "source" }] });
    expect((await run({ catalog: new FakeCatalog() }, "")).catalog).toBeUndefined();
    expect(lookupCard).not.toHaveBeenCalled();
  });
});

async function solid(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 600, height: 300, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
}

describe("FreeRecognizer catalog time and the scan's 5 minutes", () => {
  it("starts no look up later than 4 minutes after the reading began, however long the catalog may take", async () => {
    let t = 0;
    const slowReader: TextReader = { async read(img, o) { t += 230_000; return reader(TEXT).read(img, o); } };
    lookupCard.mockImplementation(async () => { t += 20_000; return result({}); });
    const r = new FreeRecognizer({ reader: slowReader, lookup: async () => null, catalog: new FakeCatalog(), clock: () => t });
    const [first] = await r.recognize({ mode: "single", photos: [photo] });
    expect(first.catalog).toEqual({ status: "none" });
    t = 0;
    const many = new FreeRecognizer({
      reader: slowReader, lookup: async () => null, catalog: new FakeCatalog(), clock: () => t,
      findBoxes: async () => [0, 1].map((i) => ({ x: 0.5 * i, y: 0, w: 0.5, h: 1 })),
    });
    lookupCard.mockClear();
    // Reading two cards takes 460 s of fake time: past 4 minutes, so no look up starts.
    const items = await many.recognize({ mode: "multi", photos: [{ role: "source", data: await solid(), width: 600, height: 300 }] });
    expect(items.map((i) => i.catalog)).toEqual([{ status: "not_checked", reason: "time" }, { status: "not_checked", reason: "time" }]);
    expect(lookupCard).not.toHaveBeenCalled();
  });
});
