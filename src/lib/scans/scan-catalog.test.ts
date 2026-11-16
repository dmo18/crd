import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogCards, catalogSources, items, scans, type Item } from "@/db/schema";
import { parseCatalog } from "@/lib/catalog/candidates";
import { pickCandidate } from "@/lib/catalog/pick";
import type { OcrResult, TextReader } from "@/lib/free/ocr";
import { FreeRecognizer } from "@/lib/free/recognizer";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";
import { FakeCatalog, recordedSearch } from "../../../tests/helpers/fake-catalog";
import { createScan } from "./create";
import { processScan } from "./process";

/** The same text for every photo. */
function reader(text: string): TextReader {
  return {
    async read(): Promise<OcrResult> {
      const lines = text.split("\n").filter(Boolean).map((t, i) => ({ text: t, confidence: 0.9, box: { x: 0.05, y: 0.05 + i * 0.08, w: 0.9, h: 0.06 } }));
      return { text, lines, confidence: 0.9 };
    },
  };
}
const WITH_NUMBER = "NO. 336\nKEN GRIFFEY JR.\nOUTFIELD MARINERS\n© 1990 THE TOPPS COMPANY, INC. BASEBALL";
const NO_NUMBER = "KEN GRIFFEY JR.\nOUTFIELD MARINERS\n© 1990 THE TOPPS COMPANY, INC. BASEBALL";
const JORDAN = "NO. 57\nMICHAEL JORDAN\nBULLS GUARD\n© 1986 FLEER BASKETBALL";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

async function scanWith(text: string, catalog?: FakeCatalog, mode: "single" | "sealed" = "single"): Promise<Item> {
  const data = await sharp({ create: { width: 600, height: 840, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const { scanId } = await createScan({ mode, photos: [{ role: mode === "single" ? "front" : "source", data }] }, db);
  const recognizer = new FreeRecognizer({ reader: reader(text), lookup: async () => null, ...(catalog ? { catalog } : {}) });
  await processScan(scanId, { db, recognizer });
  expect(db.select().from(scans).where(eq(scans.id, scanId)).get()!.status).toBe("done");
  return db.select().from(items).where(eq(items.scanId, scanId)).get()!;
}
const marks = (row: Item) => JSON.parse(row.fieldSources ?? "null");
/** The fields a reading fills, to compare a run with the catalog against one without. */
const reading = (row: Item) => ({
  sport: row.sport, year: row.year, brand: row.brand, setName: row.setName, cardNumber: row.cardNumber, player: row.player,
  team: row.team, variation: row.variation, title: row.title, confidence: row.confidence, status: row.status,
  notes: row.aiNotes, firstSuggestion: row.firstSuggestion === null ? null : { ...JSON.parse(row.firstSuggestion), at: 0 },
});

describe("a scan with the catalog (fake, recorded answers, no network)", () => {
  it("a sure card is kept, linked and filed as sure; read fields keep their reading marks", async () => {
    const catalog = new FakeCatalog();
    const item = await scanWith(WITH_NUMBER, catalog);
    expect(catalog.lines.every((l) => l === "background")).toBe(true);
    const card = db.select().from(catalogCards).get()!;
    expect(card).toMatchObject({ year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." });
    expect(db.select().from(catalogSources).get()).toMatchObject({ sourceId: "551033", catalogCardId: card.id });
    expect(item.catalogCardId).toBe(card.id);
    expect(item.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(item.status).toBe("confirmed");
    expect(item.catalogCandidates).toBeNull();
    // Everything was read already: nothing is overwritten, every mark stays `reading`.
    expect(item).toMatchObject({ player: "Ken Griffey Jr.", cardNumber: "336", team: "Seattle Mariners", setName: "Topps" });
    expect(Object.values(marks(item)).every((m) => m === "reading")).toBe(true);
    // What the scanner first read is the reading, with the reading's own confidence.
    const first = JSON.parse(item.firstSuggestion!);
    expect(first.fields).toMatchObject({ cardNumber: "336", player: "Ken Griffey Jr." });
    expect(first.confidence).toBe(0.7);
  });

  it("without a sure card the ranked candidates are kept for Review; a pick links, fills the empty number and confirms", async () => {
    const catalog = new FakeCatalog();
    const item = await scanWith(NO_NUMBER, catalog);
    expect(item.catalogCardId).toBeNull();
    expect(item.status).toBe("needs_review");
    expect(item.cardNumber).toBeNull();
    const stored = parseCatalog(item.catalogCandidates)!;
    expect(stored.status).toBe("candidates");
    expect(stored.items[0]).toMatchObject({ sourceId: "551033", cardNumber: "336" });
    expect(stored.items.length).toBeLessThanOrEqual(5);
    // Nothing is filled without the owner's tap.
    expect(db.select().from(catalogCards).all()).toHaveLength(0);

    const r = pickCandidate(item.id, 0, db);
    expect(r).toMatchObject({ ok: true, confirmed: true, differences: [] });
    const after = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(after).toMatchObject({ cardNumber: "336", status: "confirmed", catalogCandidates: null, firstSuggestion: item.firstSuggestion });
    expect(after.catalogCardId).not.toBeNull();
    expect(marks(after).cardNumber).toBe("catalog");
    expect(marks(after).player).toBe("reading");
  });

  it("catalog off, paused, at its cap, busy or failing: the scan is done, the reading is exactly as without a catalog, Review says not checked", async () => {
    const plain = reading(await scanWith(NO_NUMBER));
    for (const fail of ["off", "paused", "cap", "busy", "failed"] as const) {
      const item = await scanWith(NO_NUMBER, new FakeCatalog({ fail }));
      expect(reading(item)).toEqual(plain);
      expect(item.catalogCardId).toBeNull();
      expect(parseCatalog(item.catalogCandidates)).toMatchObject({ status: "not_checked", reason: fail, items: [] });
    }
    const broken = await scanWith(NO_NUMBER, new FakeCatalog({ throws: true }));
    expect(reading(broken)).toEqual(plain);
    expect(parseCatalog(broken.catalogCandidates)).toMatchObject({ status: "not_checked" });
  });

  it("a basketball card with only unverified listings applies nothing: the old result stands", async () => {
    const searches = { "1986 fleer michael jordan": recordedSearch("search_1986_fleer_jordan_noisy.json") };
    const plain = reading(await scanWith(JORDAN));
    const item = await scanWith(JORDAN, new FakeCatalog({ searches }));
    expect(reading(item)).toEqual(plain);
    expect(item.catalogCardId).toBeNull();
    expect(db.select().from(catalogCards).all()).toHaveLength(0);
    const stored = parseCatalog(item.catalogCandidates);
    expect(stored?.items.every((c) => !c.verified)).toBe(true);
  });

  it("sealed scans make no catalog call", async () => {
    const catalog = new FakeCatalog();
    await scanWith("1990 TOPPS BASEBALL\n36 PACKS\nWAX BOX", catalog, "sealed");
    expect(catalog.calls).toEqual([]);
  });
});
