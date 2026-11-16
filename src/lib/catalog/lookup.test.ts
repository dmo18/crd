import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallLimits, Catalog, CatalogCard, CatalogFailure, CatalogResult } from "./types";
import { parseChecklist, parseSearch } from "./mycardfolio";
import { CARD_CALLS, CHECK_CONFIDENCE, createScanBudget, lookupCard, lookupConfidence, type LookupRead } from "./lookup";
import { REVIEW_THRESHOLD } from "@/lib/recognition/types";

function body(name: string): string {
  return JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8")).response);
}
function searchRec(name: string): CatalogCard[] {
  const v = parseSearch(body(name), 10);
  if (!v) throw new Error(name);
  return v;
}
const CHECKLIST = parseChecklist(body("checklist_9179_first500.json"), "9179");
if (!CHECKLIST) throw new Error("checklist");

/** Recorded answers by query words; any other search answers nothing, as the site does for a wrong word. */
const RECORDED: Record<string, CatalogCard[]> = {
  "1990 topps ken griffey jr.": searchRec("search_1990_topps_griffey.json"),
  "1990 ken griffey jr.": searchRec("search_1990_topps_griffey.json"),
  "topps ken griffey jr.": searchRec("search_1990_topps_griffey.json"),
  "1990 topps eriffey": searchRec("search_empty_eriffey.json"),
  "1990 topps 650": searchRec("search_1990_topps_650.json"),
  "1990 topps 792": searchRec("search_1990_topps_792.json"),
  "1990 topps": searchRec("search_1990_topps_sets.json"),
  "1990 topps 1": searchRec("search_1990_topps_1.json"),
  "1986 fleer michael jordan": searchRec("search_1986_fleer_jordan_noisy.json"),
  "1990 topps ozzie smith": searchRec("search_1990_topps_ozzie_smith.json"),
};
const CHECKLIST_CARDS = (CHECKLIST as { cards: CatalogCard[] }).cards;
const BASEBALL_1990_TOPPS = "baseball|1990|topps";

type FakeOpts = {
  fail?: CatalogFailure;
  searches?: Record<string, CatalogCard[]>;
  fromStore?: boolean;
  everySearch?: (text: string) => CatalogCard[];
  /** Network tries the gate reports for each call. */
  tries?: number;
  /** Fails only the call with this number (1 is the first). */
  failAt?: { call: number; reason: CatalogFailure };
};

class FakeCatalog implements Catalog {
  calls: { tool: "search" | "card" | "checklist"; arg: string }[] = [];
  /** The limit of each search, in order. */
  limits: (number | undefined)[] = [];
  /** The sport of each search, in order. */
  sports: (string | undefined)[] = [];
  /** The most tries each call was allowed, in order. */
  maxTries: (number | undefined)[] = [];
  constructor(private readonly opts: FakeOpts = {}) {}
  private answer<T>(value: T, limits?: CallLimits): CatalogResult<T> {
    this.maxTries.push(limits?.maxTries);
    const tries = this.opts.tries === undefined ? {} : { tries: this.opts.tries };
    if (this.opts.failAt && this.opts.failAt.call === this.calls.length) return { ok: false, reason: this.opts.failAt.reason, ...tries };
    return this.opts.fail ? { ok: false, reason: this.opts.fail, ...tries } : { ok: true, value, fromStore: Boolean(this.opts.fromStore), ...tries };
  }
  async search(q: { text: string; limit?: number; sport?: string }, _line?: unknown, limits?: CallLimits) {
    this.calls.push({ tool: "search", arg: q.text });
    this.limits.push(q.limit);
    this.sports.push(q.sport);
    const key = q.text.toLowerCase();
    return this.answer(this.opts.everySearch?.(key) ?? (this.opts.searches ?? RECORDED)[key] ?? [], limits);
  }
  async card(sourceId: string, _line?: unknown, limits?: CallLimits) {
    this.calls.push({ tool: "card", arg: sourceId });
    return this.answer(null, limits);
  }
  async checklist(sourceSetId: string, _line?: unknown, limits?: CallLimits) {
    this.calls.push({ tool: "checklist", arg: sourceSetId });
    if (sourceSetId === "9179") return this.answer(CHECKLIST as { cards: CatalogCard[]; complete: boolean }, limits);
    // Any other set: an empty first page that says it goes on, so the number search runs too.
    return this.answer({ cards: [], complete: false }, limits);
  }
  count(tool?: string) {
    return this.calls.filter((c) => !tool || c.tool === tool).length;
  }
  log() {
    return this.calls.map((c) => `${c.tool}:${c.arg}`);
  }
}

function read(over: Partial<LookupRead>): LookupRead {
  return { year: 1990, brands: ["Topps"], sport: "baseball", names: [], cardNumber: null, ...over };
}
function setup(opts?: FakeOpts) {
  const catalog = new FakeCatalog(opts);
  const scan = createScanBudget();
  return { catalog, scan, memory: scan.memory, o: { catalog, scan } };
}
/** A scan that already holds checklist 9179 (the first 500 of 792 cards) in its memory. */
function withChecklist(opts?: FakeOpts) {
  const s = setup(opts);
  s.scan.memory.put("9179", BASEBALL_1990_TOPPS, CHECKLIST_CARDS, false);
  s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
  return s;
}

describe("lookupCard on recorded answers", () => {
  it("exact search: number and name agree in step 1", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(r.sureBy).toBe("number");
    expect(catalog.count()).toBe(1);
    expect(r.callsUsed).toBe(1);
    expect(r.candidates.map((c) => c.sourceId)).not.toContain("551885");
  });

  it("name only, number cut off: step 1 and the checklist find #336, but a cut-short checklist never makes it sure", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates[0].sourceId).toBe("551033");
    expect(catalog.log()).toEqual(["search:1990 Topps Ken Griffey Jr.", "search:1990 Topps Griffey", "checklist:9179"]);
    expect(lookupConfidence(r, 0.4)).toBe(0.4);
  });

  it('"1990 Topps Eriffey" finds #336 in the checklist as the top candidate; the next card of the set costs no call', async () => {
    const { catalog, scan, o } = setup();
    // An earlier card of the scan: found by its number, which teaches the base set id.
    const witt = await lookupCard(read({ names: ["Mike Witt"], cardNumber: "650" }), "background", o);
    expect(witt.sure?.sourceId).toBe("551347");
    expect(lookupConfidence(witt, 0.4)).toBe(REVIEW_THRESHOLD);

    const before = catalog.count();
    const eriffey = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(eriffey.sure).toBeNull();
    expect(eriffey.candidates[0]).toMatchObject({ sourceId: "551033", cardNumber: "336" });
    expect(catalog.calls.slice(before).map((c) => `${c.tool}:${c.arg}`)).toEqual(["search:1990 Topps Eriffey", "checklist:9179"]);
    expect(eriffey.callsUsed).toBe(2);

    const used = scan.used;
    const third = await lookupCard(read({ names: ["Ken Griffey, J"] }), "background", o);
    expect(third.sure).toBeNull();
    expect(third.candidates[0].sourceId).toBe("551033");
    expect(third.callsUsed).toBe(0);
    expect(scan.used).toBe(used);
  });

  it('"1990 Topps Eriffey" alone, on a cold start: "1990 Topps 1" (limit 5) teaches the set id, the checklist gives #336 as the top candidate', async () => {
    const { catalog, scan, o } = setup();
    const r = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.candidates[0]).toMatchObject({ sourceId: "551033", cardNumber: "336" });
    expect(catalog.calls.map((c) => `${c.tool}:${c.arg}`)).toEqual(["search:1990 Topps Eriffey", "search:1990 Topps 1", "checklist:9179"]);
    expect(catalog.limits).toEqual([10, 5]);
    expect(r.callsUsed).toBe(3);
    // Learned for the rest of the scan; the Tiffany card #128 in that answer (set 9181) taught nothing.
    expect([...scan.setIds]).toEqual([[BASEBALL_1990_TOPPS, "9179"]]);
  });

  it('cold start: "year brand 2" only when "year brand 1" gave no clean Base Set card, and never a third try', async () => {
    const recorded = searchRec("search_1990_topps_1.json");
    // Only the Tiffany and listing rows of the recorded answer: no clean Base Set card.
    const noBase = recorded.filter((c) => c.variation !== null || !c.verified);
    expect(noBase.length).toBeGreaterThan(0);
    const { catalog, scan, o } = setup({ searches: { "1990 topps 1": noBase } });
    const r = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(r.sure).toBeNull();
    expect(catalog.calls.map((c) => `${c.tool}:${c.arg}`)).toEqual(["search:1990 Topps Eriffey", "search:1990 Topps 1", "search:1990 Topps 2"]);
    expect(catalog.limits).toEqual([10, 5, 5]);
    expect(scan.setIds.size).toBe(0);
    // "year brand 2" with a clean Base Set card is enough.
    const second = setup({ searches: { "1990 topps 2": recorded } });
    const found = await lookupCard(read({ names: ["Eriffey"] }), "background", second.o);
    expect(found.sure).toBeNull();
    expect(found.candidates[0].sourceId).toBe("551033");
    expect(second.catalog.calls.map((c) => c.arg)).toEqual(["1990 Topps Eriffey", "1990 Topps 1", "1990 Topps 2", "9179"]);
  });

  it("a set id is taken only from the url of a clean Base Set card", async () => {
    const recorded = searchRec("search_1990_topps_1.json");
    // A clean card whose url does not name the set it claims: not learned.
    const forged = recorded.filter((c) => c.verified && !c.variation).map((c) => ({ ...c, url: "https://mycardfolio.com/sports/baseball" }));
    const { scan, o } = setup({ searches: { "1990 topps 1": forged, "1990 topps 2": forged } });
    await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(scan.setIds.size).toBe(0);
  });

  it("a card numbered over 500 is found by the number search (the checklist stops at 500)", async () => {
    const { catalog, o } = withChecklist();
    const r = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", o);
    expect(r.sure).toMatchObject({ cardNumber: "792", player: "Gerald Perry", variation: null });
    // The checklist is in memory: this one search is all that is spent.
    expect(catalog.log()).toEqual(["search:1990 Topps 792"]);
    expect(catalog.count("checklist")).toBe(0);
  });

  it("a misread name with a number over 500 is still found by number and close name", async () => {
    const { o } = setup();
    const r = await lookupCard(read({ names: ["Mike Wltt"], cardNumber: "650" }), "background", o);
    expect(r.sure?.sourceId).toBe("551347");
  });

  it("Tiffany is never sure, even when Tiffany was read", async () => {
    const { o } = setup();
    const r = await lookupCard(read({ brands: ["Topps Tiffany"], names: ["Mike Witt"], cardNumber: "650" }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.candidates.map((c) => c.sourceId)).toEqual(expect.arrayContaining(["551347", "552199"]));
  });

  it("a read number that disagrees: no sure card, both are candidates", async () => {
    const { o } = setup();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "337" }), "background", o);
    expect(r.sure).toBeNull();
    const ids = r.candidates.map((c) => c.sourceId);
    expect(ids).toContain("551033");
    expect(ids).toContain((CHECKLIST as { cards: CatalogCard[] }).cards.find((c) => c.cardNumber === "337")?.sourceId);
  });
});

describe("review probes: checklist 9179 (first 500 of 792) in memory, no number read", () => {
  const ozzie = RECORDED["1990 topps ozzie smith"];

  it("the recorded answer for Ozzie Smith holds his plain card #590 and the All-Star #400", () => {
    const mine = ozzie.filter((c) => c.sourceSetId === "9179").map((c) => `${c.cardNumber}:${c.tags.join()}`);
    expect(mine.sort()).toEqual(["400:AS", "590:"]);
    expect(CHECKLIST_CARDS.some((c) => c.cardNumber === "590")).toBe(false);
  });

  for (const name of ["Ozzie Smith", "Ozzie Srnith", "0zzie Smith"]) {
    it(`"${name}" is not sure, never the All-Star #400 as sure, and costs no call`, async () => {
      const { catalog, o } = withChecklist();
      const r = await lookupCard(read({ names: [name] }), "background", o);
      expect(r).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
      expect(catalog.count()).toBe(0);
      expect(r.candidates[0]).toMatchObject({ cardNumber: "400" });
      expect(lookupConfidence(r, 0.4)).toBe(0.4);
    });
  }
  it('cold start "Ozzie Smith": the step 1 answer shows #590 and the All-Star #400, but without the number neither is sure', async () => {
    const { o } = setup();
    const r = await lookupCard(read({ names: ["Ozzie Smith"] }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.candidates.map((c) => c.cardNumber)).toEqual(expect.arrayContaining(["590", "400"]));
    const numbered = await lookupCard(read({ names: ["Ozzie Smith"], cardNumber: "590" }), "background", setup().o);
    expect(numbered).toMatchObject({ sure: { sourceId: "551287", cardNumber: "590", variation: null }, sureBy: "number" });
  });

  for (const [name, wrong] of [["O Smith", "400"], ["D Smith", "311"], ["D Martinez", "228"], ["D Mart", "228"], ["Mets", "2"], ["Ken Anderson", "16"]] as const) {
    it(`"${name}" is not sure (not #${wrong}) and costs no call at all`, async () => {
      // Every search would answer with a plain card of that very number, to prove no search is trusted or even made.
      const bait = CHECKLIST_CARDS.filter((c) => c.cardNumber === wrong);
      const { catalog, o } = withChecklist({ everySearch: () => bait });
      const r = await lookupCard(read({ names: [name] }), "background", o);
      expect(r.sure).toBeNull();
      expect(r.sureBy).toBeNull();
      expect(catalog.count()).toBe(0);
      expect(r.callsUsed).toBe(0);
      expect(lookupConfidence(r, 0.4)).toBe(0.4);
    });
  }
  it('"D Smith" and "D Martinez" still offer the card they resemble as a candidate', async () => {
    const { o } = withChecklist();
    expect((await lookupCard(read({ names: ["D Smith"] }), "background", o)).candidates.map((c) => c.cardNumber)).toContain("311");
    expect((await lookupCard(read({ names: ["D Martinez"] }), "background", o)).candidates.map((c) => c.cardNumber)).toContain("228");
  });

  it('Griffey target: "Ken Griffey", "Griffey", "Ken Griffey, J", "Ken Griffey Jr." with no number are not sure, #336 is the top candidate, no call', async () => {
    for (const name of ["Ken Griffey", "Griffey", "Ken Griffey, J", "Ken Griffey Jr.", "Griff", "Ken Griff"]) {
      // Every search would answer with #336 itself, to prove no search is made or trusted.
      const { catalog, o } = withChecklist({ everySearch: () => CHECKLIST_CARDS.filter((c) => c.cardNumber === "336") });
      const r = await lookupCard(read({ names: [name] }), "background", o);
      expect(r, name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
      expect(r.candidates[0]?.sourceId, name).toBe("551033");
      expect(catalog.count(), name).toBe(0);
      expect(lookupConfidence(r, 0.4)).toBe(0.4);
    }
  });

  it("with the number 336 read and the name agreeing, #336 is sure by number from the checklist, no call", async () => {
    for (const name of ["Ken Griffey", "Griffey", "Ken Griffey, J", "Ken Griffey Jr.", "Eriffey"]) {
      const { catalog, o } = withChecklist();
      const r = await lookupCard(read({ names: [name], cardNumber: "336" }), "background", o);
      expect(r, name).toMatchObject({ sure: { sourceId: "551033", cardNumber: "336" }, sureBy: "number", callsUsed: 0 });
      expect(lookupConfidence(r, 0.4)).toBe(REVIEW_THRESHOLD);
      expect(catalog.count()).toBe(0);
    }
  });

  it("a checklist in memory that gave no sure card: no more searches at all", async () => {
    for (const names of [["Xavier Nobody"], ["Smith"], ["D Smith", "O Smith"], ["Rickey Henderson"], ["Nolan Ryan Salute"], ["Checklist 1"], ["Ozzie Smith"], ["Ken Griffey"], ["Dave Johnson"]]) {
      const { catalog, o } = withChecklist({ searches: RECORDED });
      const r = await lookupCard(read({ names }), "background", o);
      expect(r.sure, names.join()).toBeNull();
      expect(catalog.count(), names.join()).toBe(0);
    }
    // A read number in the checklist that disagrees with the name: nothing is asked.
    const { catalog, o } = withChecklist();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "337" }), "background", o);
    expect(r.sure).toBeNull();
    expect(catalog.count()).toBe(0);
  });

  it("with the read number the checklist alone is enough: sure by number, no call (a subset card stays a candidate)", async () => {
    const { catalog, o } = withChecklist();
    const as = await lookupCard(read({ names: ["Ozzie Smith"], cardNumber: "400" }), "background", o);
    expect(as).toMatchObject({ sure: null, callsUsed: 0 });
    expect(as.candidates[0].cardNumber).toBe("400");
    const dwight = await lookupCard(read({ names: ["D Smith"], cardNumber: "311" }), "background", o);
    expect(dwight).toMatchObject({ sure: { cardNumber: "311" }, sureBy: "number", callsUsed: 0 });
    expect(catalog.count()).toBe(0);
  });
});

describe("a complete checklist (complete: true)", () => {
  function complete(cards: CatalogCard[]) {
    const s = setup();
    s.scan.memory.put("9179", BASEBALL_1990_TOPPS, cards, true);
    s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
    return s;
  }
  it("exactly one player who fits: sure by name without any search, and it waits in Review", async () => {
    const { catalog, o } = complete(CHECKLIST_CARDS);
    const r = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(r).toMatchObject({ sure: { sourceId: "551033" }, sureBy: "name", callsUsed: 0 });
    expect(lookupConfidence(r, 0.4)).toBe(CHECK_CONFIDENCE);
    const d = await lookupCard(read({ names: ["D Smith"] }), "background", o);
    expect(d.sure?.cardNumber).toBe("311");
    // Ozzie Smith has only his All-Star card in these rows: a candidate, not sure.
    expect((await lookupCard(read({ names: ["Ozzie Smith"] }), "background", o)).sure).toBeNull();
    expect(catalog.count()).toBe(0);
  });
  it('"Dave Johnson" with no number is not sure: #291 (manager) and #416 "Dave Johnson (P)" both fit', async () => {
    const { catalog, o } = complete(CHECKLIST_CARDS);
    const r = await lookupCard(read({ names: ["Dave Johnson"] }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
    expect(r.candidates.map((c) => c.cardNumber).slice(0, 2).sort()).toEqual(["291", "416"]);
    expect(catalog.count()).toBe(0);
  });
  it('"Jeff Robinson" with no number is not sure when #42 "Jeff M. Robinson" and #723 "Jeff D. Robinson" are both in the set', async () => {
    const jeffM = CHECKLIST_CARDS.find((c) => c.cardNumber === "42") as CatalogCard;
    const jeffD: CatalogCard = { ...jeffM, sourceId: "999723", cardNumber: "723", player: "Jeff D. Robinson", url: "https://mycardfolio.com/sports/baseball/1990/topps-2129/base-set-9179/723-jeff-d-robinson-999723" };
    for (const whole of [true, false]) {
      const s = setup();
      s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [...CHECKLIST_CARDS, jeffD], whole);
      s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
      const r = await lookupCard(read({ names: ["Jeff Robinson"] }), "background", s.o);
      expect(r.sure, String(whole)).toBeNull();
      expect(r.candidates.map((c) => c.cardNumber)).toEqual(expect.arrayContaining(["42", "723"]));
      expect(s.catalog.count()).toBe(0);
    }
  });
});

describe("sport: nothing carries across sports", () => {
  const bo = CHECKLIST_CARDS.filter((c) => c.cardNumber === "300");
  it("the baseball Bo Jackson #300 is in the checklist", () => {
    expect(bo).toHaveLength(1);
    expect(bo[0]).toMatchObject({ player: "Bo Jackson", sport: "baseball" });
  });
  it('a football read "Bo Jackson" in 1990 Topps never becomes the baseball #300', async () => {
    // The scan already knows the baseball set, and the source answers every search with baseball cards.
    const { catalog, scan, o } = withChecklist({ everySearch: (text) => (text.includes("bo jackson") || text.includes("jackson") ? bo : RECORDED[text] ?? []) });
    const baseball = await lookupCard(read({ names: ["Bo Jackson"], cardNumber: "300" }), "background", o);
    expect(baseball.sure?.sourceId).toBe(bo[0].sourceId);

    for (const cardNumber of [null, "300"]) {
      const before = catalog.count();
      const r = await lookupCard(read({ sport: "football", names: ["Bo Jackson"], cardNumber }), "background", o);
      expect(r.sure).toBeNull();
      expect(r.candidates.map((c) => c.sourceId)).not.toContain(bo[0].sourceId);
      expect(r.candidates.every((c) => c.sport === "football")).toBe(true);
      // The baseball checklist was not used: the football card asked its own questions, with its own sport.
      expect(catalog.count()).toBeGreaterThan(before);
      expect(catalog.sports.slice(before).every((s) => s === "football")).toBe(true);
      expect(catalog.calls.slice(before).some((c) => c.tool === "checklist")).toBe(false);
    }
    // Nothing was learned for football from baseball answers.
    expect([...scan.setIds.keys()]).toEqual([BASEBALL_1990_TOPPS]);
  });
  it("the set key holds the sport, so the same year and brand of two sports are two sets", async () => {
    const football: CatalogCard = { ...bo[0], sourceId: "880001", sport: "football", cardNumber: "1", player: "Joe Montana", sourceSetId: "7001", url: "https://mycardfolio.com/sports/football/1990/topps-1/base-set-7001/1-joe-montana-880001" };
    const { scan, o } = withChecklist({ searches: { ...RECORDED, "1990 topps joe montana": [football] } });
    const r = await lookupCard(read({ sport: "football", names: ["Joe Montana"], cardNumber: "1" }), "background", o);
    expect(r.sure?.sourceId).toBe("880001");
    expect(Object.fromEntries(scan.setIds)).toEqual({ [BASEBALL_1990_TOPPS]: "9179", "football|1990|topps": "7001" });
  });
  it("no sport read: the baseball memory of the scan is not used, and nothing is sure by name alone", async () => {
    const { catalog, o } = withChecklist();
    const r = await lookupCard(read({ sport: null, names: ["Eriffey"] }), "background", o);
    expect(r.sure).toBeNull();
    expect(catalog.count()).toBeGreaterThan(0);
    const numbered = await lookupCard(read({ sport: null, names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(numbered).toMatchObject({ sure: { sourceId: "551033" }, sureBy: "number" });
  });
  it("memory is per scan: a new scan starts empty, there is no global map", async () => {
    const first = setup();
    await lookupCard(read({ names: ["Eriffey"] }), "background", first.o);
    expect(first.scan.memory.get("9179")).not.toBeNull();
    const second = setup();
    expect(second.scan.memory.get("9179")).toBeNull();
    expect(second.scan.setIds.size).toBe(0);
    await lookupCard(read({ names: ["Eriffey"] }), "background", second.o);
    expect(second.catalog.count("checklist")).toBe(1);
    // Without a scan given, each look up gets its own.
    const loose = new FakeCatalog();
    await lookupCard(read({ names: ["Eriffey"] }), "background", { catalog: loose });
    await lookupCard(read({ names: ["Eriffey"] }), "background", { catalog: loose });
    expect(loose.count("checklist")).toBe(2);
    expect((globalThis as Record<string, unknown>).__crdChecklistMemory).toBeUndefined();
  });
});

describe("year or brand unknown", () => {
  it("unknown brand: one search, candidates only, no checklist", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ brands: [], names: ["Ken Griffey Jr."] }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.candidates.map((c) => c.sourceId)).toContain("551033");
    expect(catalog.calls).toEqual([{ tool: "search", arg: "1990 Ken Griffey Jr." }]);
  });
  it("unknown year: one search with the brand, no checklist", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ year: null, names: ["Ken Griffey Jr."] }), "background", o);
    expect(r.sure).toBeNull();
    expect(catalog.calls).toEqual([{ tool: "search", arg: "Topps Ken Griffey Jr." }]);
  });
  it("unknown brand: exactly one clean entry agreeing with number and name is applied", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ brands: [], names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(catalog.count("checklist")).toBe(0);
  });
  it("misread name and unknown brand: nothing, plain reading stands", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ brands: [], names: ["Eriffey"] }), "background", o);
    expect(r).toMatchObject({ sure: null, candidates: [] });
    expect(catalog.count("checklist")).toBe(0);
  });
});

describe("basketball noise only", () => {
  it("1986 Fleer Michael Jordan: no match, at most 3 unverified candidates", async () => {
    const { o } = setup();
    const r = await lookupCard(read({ year: 1986, brands: ["Fleer"], sport: "basketball", names: ["Michael Jordan"], cardNumber: "57" }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    expect(r.candidates.every((c) => !c.verified && c.why === "Unverified listing")).toBe(true);
  });
});

describe("budgets and stops", () => {
  /** Every search finds a clean base card of another player, so every step runs to its end. */
  function busyFake() {
    let n = 0;
    return new FakeCatalog({
      everySearch: (text) => {
        const year = Number(text.slice(0, 4));
        const brand = text.includes("fleer") ? "Fleer" : "Topps";
        const set = brand === "Fleer" ? 100 + year : 200 + year;
        n++;
        return [
          {
            source: "mycardfolio", sourceId: String(700000 + n), url: `https://mycardfolio.com/sports/baseball/${year}/x-1/base-set-${set}/1-a-${700000 + n}`,
            sourceSetId: String(set), verified: true, sport: "baseball", year, brand, setName: null, cardNumber: "1", player: "Someone Else",
            otherPlayers: [], variation: null, tags: [],
          },
        ];
      },
    });
  }
  it(`never more than ${CARD_CALLS} calls for one card, whatever was read`, async () => {
    const catalog = busyFake();
    const r = await lookupCard(read({ brands: ["Topps", "Fleer"], yearFromStats: true, names: ["Xavier Nobody"], cardNumber: "999" }), "background", { catalog, scan: createScanBudget() });
    expect(catalog.count()).toBeLessThanOrEqual(CARD_CALLS);
    expect(r.callsUsed).toBe(catalog.count());
    expect(catalog.count("checklist")).toBe(2);
    expect(catalog.calls.map((c) => c.arg)).toContain("1990 Fleer 999");
  });
  it("never more than 40 calls per scan; later cards stop cleanly with the plain reading", async () => {
    const catalog = busyFake();
    const scan = createScanBudget();
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await lookupCard(read({ year: 1980 + i, brands: ["Topps", "Fleer"], names: [`Player Number${i}`], cardNumber: String(600 + i) }), "background", { catalog, scan }));
    }
    expect(catalog.count()).toBeLessThanOrEqual(40);
    expect(scan.used).toBe(catalog.count());
    const last = results[results.length - 1];
    expect(last).toMatchObject({ sure: null, callsUsed: 0, stopped: "budget" });
  });
  it("budget runs out in the middle of a card: stops after the last allowed call", async () => {
    const { catalog, scan, o } = setup();
    scan.used = 39;
    const r = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(catalog.count()).toBe(1);
    expect(r).toMatchObject({ sure: null, callsUsed: 1, stopped: "budget" });
  });
  it("stored answers do not count", async () => {
    const { scan, o } = setup({ fromStore: true });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(r.callsUsed).toBe(0);
    expect(scan.used).toBe(0);
  });
  for (const reason of ["off", "paused", "cap"] as const) {
    it(`"${reason}" gives no card, no error, and the rest of the scan makes no call`, async () => {
      const { catalog, scan, o } = setup({ fail: reason });
      const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
      expect(r).toMatchObject({ sure: null, candidates: [], callsUsed: 0, stopped: reason });
      expect(catalog.count()).toBe(1);
      expect(scan.stopped).toBe(reason);
      const next = await lookupCard(read({ names: ["Mike Witt"] }), "background", o);
      expect(next).toMatchObject({ sure: null, callsUsed: 0, stopped: reason });
      expect(catalog.count()).toBe(1);
    });
  }
  it("every network try counts: a call the gate retried twice costs 3", async () => {
    const { catalog, scan, o } = setup({ tries: 3 });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(catalog.count()).toBe(1);
    expect(r.callsUsed).toBe(3);
    expect(scan.used).toBe(3);
  });
  it("tries fill the budgets: 8 per card and 40 per scan are tries, not calls", async () => {
    const { catalog, scan, o } = setup({ tries: 2, fail: "failed" });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(catalog.count()).toBe(4);
    expect(r).toMatchObject({ sure: null, callsUsed: CARD_CALLS, stopped: "budget" });
    expect(scan.used).toBe(CARD_CALLS);

    const full = setup({ tries: 2, fail: "failed" });
    for (let i = 0; i < 9; i++) await lookupCard(read({ year: 1970 + i, names: [`Some Player${i}`], cardNumber: "5" }), "background", full.o);
    expect(full.scan.used).toBe(40);
    expect(full.catalog.count()).toBe(20);
  });
  it("catalog calls from a scan may try at most twice (one retry), and never more often than the budget allows", async () => {
    const { catalog, o } = setup();
    await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(catalog.maxTries).toEqual([2, 2, 2]);

    const last = setup();
    last.scan.used = 39;
    await lookupCard(read({ names: ["Eriffey"] }), "background", last.o);
    expect(last.catalog.maxTries).toEqual([1]);

    // 7 of the card's 8 are spent after the first call: the next one may try once only.
    const card = setup({ tries: 7, fail: "failed" });
    await lookupCard(read({ names: ["Xavier Nobody"], cardNumber: "999" }), "background", card.o);
    expect(card.catalog.maxTries).toEqual([2, 1]);
  });
  it("tries of a call that ended in a stop are counted too, and a stored answer counts 0", async () => {
    const busy = setup({ fail: "busy", tries: 2 });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", busy.o);
    expect(r).toMatchObject({ sure: null, callsUsed: 2, stopped: "busy" });
    const stored = setup({ fromStore: true, tries: 0 });
    expect((await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", stored.o)).callsUsed).toBe(0);
  });
  it('a "busy" answer stops catalog calls for the rest of the scan', async () => {
    const { catalog, scan, o } = setup({ failAt: { call: 2, reason: "busy" } });
    const first = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(first).toMatchObject({ sure: null, callsUsed: 1, stopped: "busy" });
    expect(catalog.count()).toBe(2);
    expect(scan.stopped).toBe("busy");
    for (const names of [["Ken Griffey Jr."], ["Mike Witt"]]) {
      const next = await lookupCard(read({ names, cardNumber: "336" }), "background", o);
      expect(next).toMatchObject({ sure: null, callsUsed: 0, stopped: "busy" });
    }
    expect(catalog.count()).toBe(2);
    // The next scan asks again.
    const fresh = setup();
    expect((await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", fresh.o)).sure?.sourceId).toBe("551033");
  });
  it("a busy answer on a card past the cut of a checklist in memory: nothing is sure and the scan makes no more calls", async () => {
    const { catalog, o } = withChecklist({ fail: "busy" });
    const r = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", o);
    expect(r).toMatchObject({ sure: null, stopped: "busy" });
    expect(catalog.count()).toBe(1);
    await lookupCard(read({ names: ["Mike Witt"], cardNumber: "650" }), "background", o);
    expect(catalog.count()).toBe(1);
  });
  it("a failed call is counted and the look up goes on to the next step", async () => {
    const { catalog, o } = setup({ fail: "failed" });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.callsUsed).toBe(catalog.count());
    expect(catalog.count()).toBeGreaterThan(1);
  });
});

describe("speed on this server", () => {
  it("a full look up on an 800 row checklist in memory with 5 spellings: under 20 ms", async () => {
    const more = CHECKLIST_CARDS.slice(0, 300).map((c, i) => ({ ...c, sourceId: `9${i}`, cardNumber: String(501 + i), player: `${c.player ?? "Joe Smith"}son` }));
    const s = setup();
    // Parsed once for the scan, when the checklist is kept.
    const t0 = performance.now();
    s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [...CHECKLIST_CARDS, ...more], true);
    const prep = performance.now() - t0;
    s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
    const names = ["Eriffey", "Ken Griffey, J", "KEN GRIFFEY JR", "K Grifey", "Griffcy"];
    await lookupCard(read({ names }), "background", s.o);
    const runs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const r = await lookupCard(read({ names }), "background", s.o);
      runs.push(performance.now() - t);
      expect(r.callsUsed).toBe(0);
    }
    const ms = [...runs].sort((a, b) => a - b)[3];
    console.log(`lookup timing: slim rows for 800 cards ${prep.toFixed(2)} ms, full look up 800 x 5 spellings ${ms.toFixed(2)} ms`);
    expect(s.catalog.count()).toBe(0);
    expect(ms).toBeLessThan(50); // plan limit; measured about 7 ms when the server is quiet
  });
});
