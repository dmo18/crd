import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { catalogSources, items, type Item } from "@/db/schema";
import { CACHE_KEEP_MS } from "@/lib/outside/cache";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { rookieAsk } from "@/lib/items/rookie";
import { recognizedItemSchema, type RecognizedItem } from "@/lib/recognition/types";
import { FakeCatalog, recordedSearch } from "../../../tests/helpers/fake-catalog";
import { parseCatalog, serializeCatalog, type OfferCandidate } from "./candidates";
import {
  buildQueries, findCard, isVerifiedMatch, offerCandidates, pickMatch, productOf, searchWords, surnameWords, type FindRead,
} from "./find";
import { createScanBudget } from "./lookup";
import { parseChecklist, toCard } from "./mycardfolio";
import { autoLinkIn, catalogSaysRookie, linkedFacts, lookUpAgain, lookUpAgainLine, pickCandidate, resetLookupLimitForTests, reviewCatalogView, undoLink } from "./pick";
import type { Catalog, CatalogCard, CatalogResult } from "./types";

/**
 * S1a: finding a read card in the catalog with few calls, offering only the
 * read player, and linking exactly one verified match. Every answer here is a
 * recorded live answer (tests/fixtures/catalog/s1a_*.json and older ones) or
 * a row built from one; nothing touches the network.
 */

const rec = (name: string, limit = 10) => recordedSearch(name, limit);
/** Every row of a recorded answer, listings too (the client keeps only clean rows when there are any). */
const allRows = (name: string): CatalogCard[] => {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8"));
  return JSON.parse(raw.response.result.content[0].text).results.map((row: unknown) => toCard(row)).filter(Boolean);
};
const MILACKI = rec("s1a_1992_donruss_101_milacki.json");
const ACUNA = rec("s1a_2021_prizm_sg4_acuna.json");
const HASLETT = rec("s1a_haslett.json");
const RUSHING = rec("s1a_rushing_leaders.json");
const HARDAWAY = rec("s1a_hardaway.json");
const JONES = rec("versions_1991_topps_333_jones.json", 20);
const GRIFFEY = rec("search_1990_topps_griffey.json");
const WITT = rec("search_1990_topps_650.json");
const CHECKLIST_9179 = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog/checklist_9179_first500.json"), "utf8"));
  return parseChecklist(JSON.stringify(raw.response), "9179")!;
})();

const read = (over: Partial<FindRead>): FindRead => ({
  sport: "baseball", year: null, brand: null, setName: null, cardNumber: null, player: null, team: null, unsure: [], ...over,
});

/** A fake catalog that also counts stored answers and can answer a checklist for any set. */
class Recorded implements Catalog {
  calls: string[] = [];
  constructor(private readonly searches: Record<string, CatalogCard[]>, private readonly opts: { stored?: boolean; checklists?: Record<string, CatalogCard[]> } = {}) {}
  async search(q: { text: string }): Promise<CatalogResult<CatalogCard[]>> {
    this.calls.push(`search:${q.text}`);
    return { ok: true, value: this.searches[q.text.toLowerCase()] ?? [], fromStore: Boolean(this.opts.stored) };
  }
  async card(): Promise<CatalogResult<CatalogCard | null>> {
    this.calls.push("card");
    return { ok: true, value: null, fromStore: false };
  }
  async checklist(id: string): Promise<CatalogResult<{ cards: CatalogCard[]; complete: boolean }>> {
    this.calls.push(`checklist:${id}`);
    const cards = this.opts.checklists?.[id] ?? (id === "9179" ? CHECKLIST_9179.cards : []);
    return { ok: true, value: { cards, complete: false }, fromStore: Boolean(this.opts.stored) };
  }
}

const offer = (c: CatalogCard): OfferCandidate => ({ ...c, score: 0, why: "", differs: null });

describe("A: the searches", () => {
  it("Milacki: product first, number and surname; the right card in one call", async () => {
    const r = read({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    expect(buildQueries(r).map((q) => q.text)).toEqual(["1992 Donruss 101 Milacki", "1992 Donruss Milacki"]);
    const catalog = new Recorded({ "1992 donruss 101 milacki": MILACKI });
    const found = await findCard(r, "now", { catalog });
    expect(catalog.calls).toEqual(["search:1992 Donruss 101 Milacki"]);
    expect(found.match?.sourceId).toBe("2310072");
    expect(found.callsUsed).toBe(1);
  });

  it("Acuna: the product (Prizm), not the maker, and no accents; the catalog has it only as unverified listings", async () => {
    const r = read({ year: 2021, brand: "Panini", setName: "Prizm", cardNumber: "SG-4", player: "Ronald Acuña Jr." });
    expect(productOf("Panini", "Prizm")).toBe("Prizm");
    expect(surnameWords("Ronald Acuña Jr.")).toBe("Acuna");
    expect(buildQueries(r)[0].text).toBe("2021 Prizm SG-4 Acuna");
    const catalog = new Recorded({ "2021 prizm sg-4 acuna": ACUNA });
    const found = await findCard(r, "now", { catalog });
    // The two listings are one card (same year, product, number and player): offered once, marked, never linked.
    expect(found.candidates.map((c) => [c.sourceId, c.verified])).toEqual([["ebay_99d06a88a8a0", false]]);
    expect(found.match).toBeNull();
    expect(found.callsUsed).toBeLessThanOrEqual(3);
  });

  it("Ricci: the catalog has no 1990 Upper Deck #355 Mike Ricci (recorded: number, surname, any sport all empty); 2 calls, no filler", async () => {
    const r = read({ sport: "hockey", year: 1990, brand: "Upper Deck", cardNumber: "355", player: "Mike Ricci" });
    const texts = buildQueries(r).map((q) => q.text);
    expect(texts).toEqual(["1990 Upper Deck 355 Ricci", "1990 Upper Deck Ricci"]);
    const empty = [rec("s1a_1990_upper_deck_355_ricci.json"), rec("s1a_1990_upper_deck_ricci.json"), rec("s1a_1990_upper_deck_ricci_any_sport.json")];
    expect(empty.every((a) => a.length === 0)).toBe(true);
    const catalog = new Recorded({});
    const found = await findCard(r, "now", { catalog });
    expect(found.candidates).toEqual([]);
    expect(catalog.calls).toEqual(texts.map((t) => `search:${t}`));
  });

  it("never asks filler searches like year, maker and a lone number the card did not show", () => {
    for (const r of [
      read({ year: 1990, brand: "Upper Deck", player: "Mike Ricci" }),
      read({ year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." }),
      read({ year: 1990, brand: "Topps" }),
    ]) {
      const texts = buildQueries(r).map((q) => q.text);
      expect(texts.length).toBeLessThanOrEqual(3);
      expect(texts.some((t) => /^\d{4} [A-Za-z ]+ [12]$/.test(t))).toBe(false);
    }
    expect(buildQueries(read({ year: 1990, brand: "Topps" }))).toEqual([]);
  });

  it("an unsure name adds the number search (3 calls at most), and a season sport uses its first year", () => {
    const r = read({ sport: "hockey", year: 1990, brand: "Upper Deck", cardNumber: "355", player: "Mike Ricci", unsure: ["player"] });
    expect(buildQueries(r).map((q) => q.text)).toEqual(["1990 Upper Deck 355 Ricci", "1990 Upper Deck Ricci", "1990 Upper Deck 355"]);
    expect(buildQueries(r).every((q) => q.year === 1990)).toBe(true);
  });

  it("stored answers and answers of the same scan cost no call", async () => {
    const r = read({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    const stored = await findCard(r, "now", { catalog: new Recorded({ "1992 donruss 101 milacki": MILACKI }, { stored: true }) });
    expect(stored.callsUsed).toBe(0);
    const scan = createScanBudget();
    const catalog = new Recorded({ "1992 donruss 101 milacki": MILACKI });
    await findCard(r, "background", { catalog, scan });
    const second = await findCard(r, "background", { catalog, scan });
    expect(second.callsUsed).toBe(0);
    expect(catalog.calls).toHaveLength(1);
  });

  it("the words for Find this card in the catalog: year, product, number and player", () => {
    expect(searchWords({ year: 1992, brand: "Donruss", setName: null, cardNumber: "101", player: "Bob Milacki" })).toBe("1992 Donruss 101 Bob Milacki");
    expect(searchWords({ year: 2021, brand: "Panini", setName: "Prizm", cardNumber: "SG-4", player: "Ronald Acuña Jr." })).toBe("2021 Prizm SG-4 Ronald Acuna Jr.");
  });
});

describe("B: which candidates are offered", () => {
  it("Haslett: a Rushing Leaders card is never offered, even with the same year and number", () => {
    // 1984 Topps #204 is RUSHING LEADERS (recorded); Haslett's own card is 1985 Topps #204.
    const r = read({ sport: "football", year: 1984, brand: "Topps", cardNumber: "204", player: "Jim Haslett", unsure: ["year"] });
    const offered = offerCandidates(r, [...RUSHING, ...HASLETT]);
    expect(offered.map((c) => c.player)).not.toContain("Rushing Leaders");
    expect(offered.every((c) => c.player === "Jim Haslett")).toBe(true);
    // The unsure year: his 1985 #204 is shown, with the difference in plain words.
    const his = offered.find((c) => c.sourceId === "612498")!;
    expect(his.differs).toBe("The catalog says 1985. The card reads 1984.");
    // A sure year drops it.
    expect(offerCandidates({ ...r, unsure: [] }, HASLETT).map((c) => c.sourceId)).toEqual([]);
  });

  it("Chipper Jones: another Braves player (Marcus Giles) is never offered", () => {
    // The recorded 1991 Topps #333 answer, plus a Marcus Giles row built like a clean entry (no live call spent on it).
    const giles: CatalogCard = { ...JONES[0], sourceId: "999001", player: "Marcus Giles", cardNumber: "333", url: "https://mycardfolio.com/sports/baseball/1991/topps-1/base-set-1/333-marcus-giles-999001" };
    const r = read({ year: 1991, brand: "Topps", cardNumber: "333", player: "Chipper Jones" });
    const offered = offerCandidates(r, [giles, ...JONES]);
    expect(offered.map((c) => c.player)).not.toContain("Marcus Giles");
    expect(offered.every((c) => c.player?.startsWith("Chipper Jones"))).toBe(true);
    // Unverified listings come last and are marked.
    const firstListing = offered.findIndex((c) => !c.verified);
    if (firstListing >= 0) expect(offered.slice(firstListing).every((c) => !c.verified)).toBe(true);
    const withListings = offerCandidates(r, allRows("versions_1991_topps_333_jones.json"));
    const at = withListings.findIndex((c) => !c.verified);
    expect(at).toBeGreaterThan(0);
    expect(withListings.slice(at).every((c) => !c.verified)).toBe(true);
  });

  it("Tim Hardaway: Anfernee Hardaway is never offered, and another number only with an unsure read number", () => {
    const r = read({ sport: "basketball", year: 2001, brand: "Fleer", cardNumber: "65", player: "Tim Hardaway" });
    const offered = offerCandidates(r, HARDAWAY);
    expect(offered.some((c) => /anfernee|penny/i.test(c.player ?? ""))).toBe(false);
    // Sure number 65: the #73 cards are not offered.
    expect(offered.map((c) => c.cardNumber)).not.toContain("73");
    const unsure = offerCandidates({ ...r, unsure: ["cardNumber"] }, HARDAWAY);
    const e = unsure.find((c) => c.sourceId === "1250636")!;
    expect(e.differs).toBe("The catalog says number 73. The card reads 65.");
    // The listing whose product is the player's own name is shown last and marked.
    const own = offerCandidates(read({ sport: "basketball", year: 1997, cardNumber: "330", player: "Tim Hardaway" }), allRows("s1a_hardaway.json"));
    expect(own.find((c) => c.sourceId === "ebay_f98a2e155bca")?.verified).toBe(false);
  });

  it("duplicates are offered once: same id, or same year, product, number and player", () => {
    const r = read({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    const twin = { ...MILACKI[0], sourceId: "ebay_x1", verified: false };
    expect(offerCandidates(r, [...MILACKI, ...MILACKI, twin]).map((c) => c.sourceId)).toEqual(["2310072"]);
  });
});

describe("C: a verified match", () => {
  it("Milacki: exactly one, linked by the scan as This is my card would, with Undo", async () => {
    const db = createDb(":memory:");
    const found = await findCard(read({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" }), "background", {
      catalog: new Recorded({ "1992 donruss 101 milacki": MILACKI }),
    });
    const recognized: RecognizedItem = recognizedItemSchema.parse({
      kind: "card", confidence: 0.6, sourceIndex: 0, box: null, sport: "baseball", year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki",
    });
    recognized.evidence = { certainty: { year: "unsure", brand: "unsure", cardNumber: "sure", player: "sure", sport: "sure" } };
    recognized.catalog = { status: "matched", candidates: found.candidates };
    const now = new Date();
    const id = db.insert(items).values(itemFromRecognition(recognized, { scanId: null as unknown as number, locationId: null, valueSource: "ai_estimate", now })).returning().get().id;
    expect(autoLinkIn(db, id, now)).toBe(true);
    const item = db.select().from(items).where(eq(items.id, id)).get()!;
    expect(item.catalogCardId).not.toBeNull();
    expect(item).toMatchObject({ status: "confirmed", year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki" });
    const marks = JSON.parse(item.fieldSources!);
    expect(marks).toMatchObject({ year: "catalog", brand: "catalog", cardNumber: "catalog", player: "catalog" });
    const facts = linkedFacts(item, db)!;
    expect(facts).toMatchObject({ auto: true, line: "1992 Donruss #101 Bob Milacki", url: MILACKI[0].url, confirmed: ["year", "brand", "cardNumber", "player"] });
    expect(db.select().from(catalogSources).get()?.sourceId).toBe("2310072");

    expect(undoLink(id, db, now).ok).toBe(true);
    const back = db.select().from(items).where(eq(items.id, id)).get()!;
    expect(back).toMatchObject({ catalogCardId: null, status: "needs_review", confidence: 0.6 });
    expect(reviewCatalogView(back, db, now)?.candidates[0]).toMatchObject({ sourceId: "2310072" });
  });

  it("Hardaway: picking a #67 candidate never writes 67 over the read 65", () => {
    const db = createDb(":memory:");
    const now = new Date();
    const row = { ...HARDAWAY.find((c) => c.sourceId === "1250636")!, cardNumber: "67", sourceId: "1250999" };
    const id = db.insert(items).values({
      kind: "card", status: "needs_review", title: "2001 Fleer #65 Tim Hardaway", sport: "basketball", year: 2001, brand: "Fleer", cardNumber: "65", player: "Tim Hardaway",
      fieldSources: JSON.stringify({ sport: "reading", year: "reading", brand: "reading", cardNumber: "reading", player: "reading" }),
      catalogCandidates: serializeCatalog({ status: "candidates", items: [row] }, now), createdAt: now, updatedAt: now,
    }).returning().get().id;
    const r = pickCandidate(id, 0, "1250999", db, now);
    expect(r).toMatchObject({ ok: true, confirmed: false });
    expect(db.select().from(items).where(eq(items.id, id)).get()!.cardNumber).toBe("65");
  });

  const base336 = GRIFFEY.find((c) => c.sourceId === "551033")!;
  const griffeyRead = read({ year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." });

  it("earlier failures do not link: a read product line (Topps Chrome) against the base card", () => {
    const r = { ...griffeyRead, setName: "Topps Chrome" };
    expect(buildQueries(r)[0].text).toBe("1990 Topps Chrome 336 Griffey");
    expect(pickMatch(r, offerCandidates(r, [base336])).match).toBeNull();
  });

  it("base and Tiffany: the plain base card is the match (the version question stays open); only Tiffany for a plain Topps read still does not link", () => {
    const tiffany = WITT.find((c) => c.variation === "Tiffany")!;
    const tiff336 = { ...tiffany, sourceId: "551885", cardNumber: "336", player: "Ken Griffey Jr." };
    const both = pickMatch(griffeyRead, offerCandidates(griffeyRead, [base336, tiff336]));
    expect(both).toMatchObject({ matches: 2, assumedBase: true });
    expect(both.match?.sourceId).toBe("551033");
    // The card itself reads the version: nothing is assumed.
    expect(pickMatch({ ...griffeyRead, variation: "Tiffany" }, offerCandidates(griffeyRead, [base336, tiff336]))).toEqual({ match: null, matches: 2 });
    expect(pickMatch({ ...griffeyRead, brand: "Topps Tiffany" }, offerCandidates(griffeyRead, [base336, tiff336])).match).toBeNull();
    // Two plain base entries, or a version word that is not on the known list: no link.
    const base2 = { ...base336, sourceId: "551034", sourceSetId: "777", setName: "Major League Debut" };
    expect(pickMatch(griffeyRead, offerCandidates(griffeyRead, [base336, base2, tiff336])).match).toBeNull();
    const odd = { ...tiff336, variation: "Rainbow Special" };
    expect(pickMatch(griffeyRead, offerCandidates(griffeyRead, [base336, odd])).match).toBeNull();
    expect(pickMatch(griffeyRead, offerCandidates(griffeyRead, [tiff336]))).toEqual({ match: null, matches: 1 });
  });

  it("earlier failures do not link: no number read (Jeff Robinson), a misread number of Ken Griffey Sr., no year (Nolan Ryan)", () => {
    const robinson = [{ ...base336, sourceId: "1", cardNumber: "42", player: "Jeff Robinson" }, { ...base336, sourceId: "2", cardNumber: "723", player: "Jeff Robinson" }];
    const rr = read({ year: 1990, brand: "Topps", player: "Jeff Robinson" });
    expect(pickMatch(rr, offerCandidates(rr, robinson)).match).toBeNull();
    const senior = { ...base336, sourceId: "3", cardNumber: "581", player: "Ken Griffey Sr." };
    const misread = { ...griffeyRead, cardNumber: "581" };
    expect(offerCandidates(misread, [senior])).toEqual([]);
    const ryan = { ...base336, sourceId: "620119", year: 1992, cardNumber: "1", player: "Nolan Ryan" };
    const noYear = read({ brand: "Topps", cardNumber: "1", player: "Nolan Ryan" });
    expect(pickMatch(noYear, offerCandidates(noYear, [ryan])).match).toBeNull();
  });

  it("earlier failures do not link: no sport read and the same card in two sports (Bo Jackson #300), a second clean set, a stat row year, a listing", () => {
    const bo = { ...base336, sourceId: "10", cardNumber: "300", player: "Bo Jackson" };
    const boFootball = { ...bo, sourceId: "11", sport: "football" as const };
    const noSport = read({ sport: null, year: 1990, brand: "Topps", cardNumber: "300", player: "Bo Jackson" });
    expect(pickMatch(noSport, offerCandidates(noSport, [bo, boFootball])).match).toBeNull();
    const otherSet = { ...base336, sourceId: "12", sourceSetId: "777", setName: "Major League Debut" };
    expect(pickMatch(griffeyRead, offerCandidates(griffeyRead, [base336, otherSet])).match).toBeNull();
    expect(pickMatch({ ...griffeyRead, yearFromStats: true }, offerCandidates(griffeyRead, [base336])).match).toBeNull();
    const listing = GRIFFEY.find((c) => !c.verified) ?? { ...base336, sourceId: "ebay_1", verified: false };
    expect(isVerifiedMatch(griffeyRead, offer(listing))).toBe(false);
  });

  it("Chipper Jones #333: base, Desert Shield and Tiffany all agree, so the base is linked and the version question stays open", () => {
    const r = read({ year: 1991, brand: "Topps", cardNumber: "333", player: "Chipper Jones" });
    const got = pickMatch(r, offerCandidates(r, JONES));
    expect(got).toMatchObject({ matches: 3, assumedBase: true });
    expect(got.match?.variation).toBeNull();
  });
});

describe("D: the set's checklist", () => {
  const sure = { year: 1990, brand: "Topps" } as const;

  it("a number and no player: the player comes from the checklist as unsure; 1 search and 1 checklist call", async () => {
    const r = read({ ...sure, cardNumber: "336" });
    const catalog = new Recorded({ "1990 topps 336": GRIFFEY });
    const found = await findCard(r, "background", { catalog });
    expect(catalog.calls).toEqual(["search:1990 Topps 336", "checklist:9179"]);
    expect(found.fills).toEqual([{ field: "player", value: "Ken Griffey Jr.", sure: false }]);
    expect(found.match).toBeNull();
    expect(found.candidates[0].sourceId).toBe("551033");
    expect(found.callsUsed).toBeLessThanOrEqual(4);
  });

  it("an unsure read player with a clean card of that number is a verified match (no checklist); a player the checklist contradicts changes nothing and is noted", async () => {
    const agree = await findCard(read({ ...sure, cardNumber: "336", player: "Ken Griffey Jr.", unsure: ["player"] }), "background", {
      catalog: new Recorded({ "1990 topps 336": GRIFFEY, "1990 topps 336 griffey": [] , "1990 topps griffey": [] }),
    });
    // The search answer found the clean card first: no checklist needed then.
    expect(agree.match?.sourceId).toBe("551033");
    // No clean card of the number in the answers, only another card of the set: the checklist is the second sign.
    const viaList = new Recorded({ "1990 topps 336": WITT });
    const second = await findCard(read({ ...sure, cardNumber: "336", player: "Ken Griffey Jr.", unsure: ["player"] }), "background", { catalog: viaList });
    expect(viaList.calls).toEqual(["search:1990 Topps 336 Griffey", "search:1990 Topps Griffey", "search:1990 Topps 336", "checklist:9179"]);
    expect(second.callsUsed).toBe(4);
    expect(second.fills).toEqual([{ field: "player", value: "Ken Griffey Jr.", sure: true }]);
    expect(second.match).toBeNull();
    const r = read({ ...sure, cardNumber: "336", player: "Kenny Rogers", unsure: ["player"] });
    const other = await findCard(r, "background", { catalog: new Recorded({ "1990 topps 336": GRIFFEY }) });
    expect(other.fills).toEqual([]);
    expect(other.notes.join(" ")).toMatch(/has Ken Griffey Jr\. as number 336\. The card reads Kenny Rogers/);
  });

  it("a player and no number: the number from the checklist as unsure", async () => {
    const catalog = new Recorded({ "1990 topps griffey": GRIFFEY });
    const found = await findCard(read({ ...sure, player: "Ken Griffey Jr." }), "background", { catalog });
    expect(catalog.calls).toEqual(["search:1990 Topps Griffey", "checklist:9179"]);
    expect(found.fills).toEqual([{ field: "cardNumber", value: "336", sure: false }]);
  });

  it("a checklist entry against a sure team changes nothing and is noted", async () => {
    const withTeam = CHECKLIST_9179.cards.map((c) => (c.cardNumber === "336" ? { ...c, team: "Seattle Mariners" } : c));
    const catalog = new Recorded({ "1990 topps 336": GRIFFEY }, { checklists: { "9179": withTeam } });
    const found = await findCard(read({ ...sure, cardNumber: "336", team: "New York Yankees" }), "background", { catalog });
    expect(found.fills).toEqual([]);
    expect(found.notes.join(" ")).toMatch(/so nothing was changed/);
  });

  it("no checklist without a sure year and maker, and checklists are kept a long time in the stored answers", async () => {
    const catalog = new Recorded({ "1990 topps 336": GRIFFEY });
    await findCard(read({ ...sure, cardNumber: "336", unsure: ["year"] }), "background", { catalog });
    expect(catalog.calls.some((c) => c.startsWith("checklist"))).toBe(false);
    expect(CACHE_KEEP_MS.checklist).toBeGreaterThanOrEqual(30 * 86_400_000);
  });
});

describe("E, F and G: item page and Look up again", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    resetLookupLimitForTests();
  });
  const insert = (over: Partial<Item>) => db.insert(items).values({
    kind: "card", status: "confirmed", title: "Card", fieldSources: JSON.stringify({ year: "reading", brand: "reading", cardNumber: "reading", player: "reading" }), ...over,
  } as typeof items.$inferInsert).returning().get();

  it("a clean entry's rookie wording is offered through the rookie question; a listing's is not", () => {
    const clean = { ...MILACKI[0], details: "RC" };
    expect(catalogSaysRookie({ verified: true, details: clean.details, setName: null })).toBe(true);
    expect(catalogSaysRookie({ verified: false, details: "RC, SP", setName: null })).toBe(false);
    const ask = rookieAsk({ kind: "card", isRookie: false, rookieState: null, rookieSource: null, rookieNote: null, rarityNotes: null }, ["RC"]);
    expect(ask?.suggested).toBe("yes");
    expect(ask?.current).toBeNull();
  });

  it("Look up again uses the new searches and links one verified match, with a plain result line", async () => {
    const item = insert({ year: 1992, brand: "Donruss", cardNumber: "101", player: "Bob Milacki", sport: "baseball" });
    const catalog = new Recorded({ "1992 donruss 101 milacki": MILACKI });
    const r = await lookUpAgain(item.id, { db, catalog });
    expect(catalog.calls).toEqual(["search:1992 Donruss 101 Milacki"]);
    expect(lookUpAgainLine(r)).toBe("Matched to the catalog: 1992 Donruss #101 Bob Milacki.");
    const after = db.select().from(items).where(eq(items.id, item.id)).get()!;
    expect(after.catalogCardId).not.toBeNull();
    expect(parseCatalog(after.catalogCandidates)?.linked?.auto).toBe(true);
  });

  it("Look up again: none, found N and the catalog did not answer", async () => {
    const ricci = insert({ year: 1990, brand: "Upper Deck", cardNumber: "355", player: "Mike Ricci", sport: "hockey" });
    expect(lookUpAgainLine(await lookUpAgain(ricci.id, { db, catalog: new Recorded({}) }))).toMatch(/^None found in the catalog/);
    const acuna = insert({ year: 2021, brand: "Panini", setName: "Prizm", cardNumber: "SG-4", player: "Ronald Acuña Jr." });
    expect(lookUpAgainLine(await lookUpAgain(acuna.id, { db, catalog: new Recorded({ "2021 prizm sg-4 acuna": ACUNA }) }))).toBe("Found 1 possible card.");
    const down = insert({ year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." });
    expect(lookUpAgainLine(await lookUpAgain(down.id, { db, catalog: new FakeCatalog({ fail: "failed" }) }))).toBe("The catalog did not answer. Try again later.");
  });
});
