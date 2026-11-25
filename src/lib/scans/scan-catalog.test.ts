import sharp from "sharp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogCards, catalogSources, items, scans, type Item } from "@/db/schema";
import { parseCatalog } from "@/lib/catalog/candidates";
import { pickCandidate, undoLink } from "@/lib/catalog/pick";
import { versionView } from "@/lib/catalog/version-view";
import { chooseVersion, parseVersions } from "@/lib/catalog/versions";
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
  // The uncut photos are those of each scan (their ids differ from scan to scan): their sizes count, not their ids.
  notes: row.aiNotes, firstSuggestion: row.firstSuggestion === null ? null : withoutPhotoIds({ ...JSON.parse(row.firstSuggestion), at: 0 }),
});
function withoutPhotoIds(s: { uncut?: { id: number; w: number; h: number }[] }) {
  return s.uncut ? { ...s, uncut: s.uncut.map(({ w, h }) => ({ w, h })) } : s;
}

describe("a scan with the catalog (fake, recorded answers, no network)", () => {
  it("S1a: exactly one verified match is linked by the scan as This is my card would; Undo puts the item back", async () => {
    // The recorded answer (limit 5) has the clean base card 551033 and no Tiffany row: one verified match.
    const catalog = new FakeCatalog();
    const item = await scanWith(WITH_NUMBER, catalog);
    expect(catalog.lines.every((l) => l === "background")).toBe(true);
    expect(db.select().from(catalogSources).all().map((s) => s.sourceId)).toEqual(["551033"]);
    expect(item.catalogCardId).not.toBeNull();
    const stored = parseCatalog(item.catalogCandidates)!;
    expect(stored).toMatchObject({ status: "linked", linked: { position: 0, auto: true, before: { status: "needs_review", confidence: 0.6 } } });
    // Nothing read is changed; the agreeing fields are confirmed by the catalog, the empty sport is filled.
    expect(item).toMatchObject({ player: "Ken Griffey Jr.", cardNumber: "336", year: 1990, brand: "Topps", status: "confirmed" });
    expect(marks(item)).toMatchObject({ player: "catalog", cardNumber: "catalog", year: "catalog", brand: "catalog" });
    expect(item.confidence).toBe(REVIEW_THRESHOLD);
    const first = JSON.parse(item.firstSuggestion!);
    // 12R.4: one sign each for year, brand and number, the name on one side only.
    expect(first.confidence).toBe(0.6);

    expect(undoLink(item.id, db)).toEqual({ ok: true });
    const back = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(back).toMatchObject({ catalogCardId: null, status: "needs_review", confidence: 0.6, player: "Ken Griffey Jr.", cardNumber: "336" });
    expect(Object.values(marks(back)).every((m) => m === "reading")).toBe(true);
    const again = parseCatalog(back.catalogCandidates)!;
    expect(again.status).toBe("candidates");
    expect(again.items[0]).toMatchObject({ sourceId: "551033" });
  });

  it("base and Tiffany both agree: the base is linked, the version stays an open question, assumed and not the owner's answer", async () => {
    const griffey = recordedSearch("search_1990_topps_griffey.json");
    const base = griffey.find((c) => c.sourceId === "551033")!;
    const tiffany = { ...base, sourceId: "551885", brand: "Topps", variation: "Tiffany", url: "https://mycardfolio.com/sports/baseball/1990/topps-tiffany-2131/base-set-9181/336-ken-griffey-jr-551885", sourceSetId: "9181" };
    const catalog = new FakeCatalog({ searches: { "1990 topps 336 griffey": [base, tiffany] } });
    const item = await scanWith(WITH_NUMBER, catalog);
    expect(item.catalogCardId).not.toBeNull();
    expect(db.select().from(catalogSources).get()?.sourceId).toBe("551033");
    expect(item).toMatchObject({ versionState: null, versionSource: null, variation: null });
    const list = parseVersions(item.versionOptions)!;
    expect(list.assumed).toBe(true);
    expect(list.options.map((o) => o.name)).toEqual(["The normal card (base)", "Tiffany", "O-Pee-Chee", "Another version", "Not sure yet"]);
    expect(list.options[1].card?.sourceId).toBe("551885");
    const view = versionView(item);
    expect(view).toMatchObject({ assumed: true, stateLine: "Assumed the normal version. Tap to change." });
    expect(catalog.calls).toEqual(["search:1990 Topps 336 Griffey"]);

    // Undo of the automatic link takes the assumption with it and brings the list back.
    expect(undoLink(item.id, db)).toEqual({ ok: true });
    const back = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(back).toMatchObject({ catalogCardId: null, versionOptions: null });
    expect(parseCatalog(back.catalogCandidates)!.items.map((c) => c.sourceId)).toEqual(["551033", "551885"]);
  });

  it("the owner's tap on the normal card in the list makes it the owner's answer", async () => {
    const griffey = recordedSearch("search_1990_topps_griffey.json");
    const base = griffey.find((c) => c.sourceId === "551033")!;
    const tiffany = { ...base, sourceId: "551885", brand: "Topps", variation: "Tiffany", sourceSetId: "9181" };
    const item = await scanWith(WITH_NUMBER, new FakeCatalog({ searches: { "1990 topps 336 griffey": [base, tiffany] } }));
    const at = parseVersions(item.versionOptions)!.at;
    expect(chooseVersion(item.id, { position: 0, listAt: at }, db)).toMatchObject({ ok: true, state: "confirmed", source: "owner" });
    const after = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(after).toMatchObject({ versionState: "confirmed", versionOptions: null });
    expect(after.catalogCardId).toBe(item.catalogCardId);
    expect(versionView(after).assumed).toBe(false);
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

    const r = pickCandidate(item.id, 0, "551033", db);
    expect(r).toMatchObject({ ok: true, confirmed: true, differences: [] });
    const after = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(after).toMatchObject({ cardNumber: "336", status: "confirmed", firstSuggestion: item.firstSuggestion });
    expect(parseCatalog(after.catalogCandidates)).toMatchObject({ status: "linked", linked: { auto: false } });
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
