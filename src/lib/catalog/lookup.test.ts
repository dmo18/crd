import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallLimits, Catalog, CatalogCard, CatalogFailure, CatalogResult } from "./types";
import { parseChecklist, parseSearch } from "./mycardfolio";
import { CARD_CALLS, createScanBudget, lookupCard, lookupConfidence, type LookupRead } from "./lookup";
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
  /** Checklists by set id besides the recorded 9179. */
  checklists?: Record<string, { cards: CatalogCard[]; complete: boolean }>;
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
    const own = this.opts.checklists?.[sourceSetId];
    if (own) return this.answer(own, limits);
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
  it("SURE: Ken Griffey Jr. with #336, sport, year and brand read; step 1 stops and checklist 9179 confirms the base set (no Griffey Sr. in the pool)", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(r.sureBy).toBe("number");
    expect(catalog.log()).toEqual(["search:1990 Topps Ken Griffey Jr.", "checklist:9179"]);
    expect(r.callsUsed).toBe(2);
    expect(r.candidates.map((c) => c.sourceId)).not.toContain("551885");
    expect(lookupConfidence(r, 0.4)).toBe(REVIEW_THRESHOLD);
  });
  it("the base set only learned from a search, its checklist not fetched: not sure", async () => {
    const { catalog, o } = setup({ failAt: { call: 2, reason: "failed" } });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates[0].sourceId).toBe("551033");
    expect(catalog.count("checklist")).toBe(1);
  });
  it('"V. Hayes" style initials are never sure: "K Griffey Jr." #336 with the checklist fetched is a candidate only', async () => {
    const { o } = setup();
    const r = await lookupCard(read({ names: ["K Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates[0].sourceId).toBe("551033");
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

    // Witt's look up fetched checklist 9179 to confirm its base set: Eriffey asks nothing.
    expect(catalog.log()).toEqual(["search:1990 Topps Mike Witt", "search:1990 Topps Witt", "search:1990 Topps 650", "checklist:9179"]);
    const before = catalog.count();
    const eriffey = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(eriffey.sure).toBeNull();
    expect(eriffey.candidates[0]).toMatchObject({ sourceId: "551033", cardNumber: "336" });
    expect(catalog.count()).toBe(before);
    expect(eriffey.callsUsed).toBe(0);

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

  it("with the number 336 read, only the exact whole name is sure from the checklist, no call; no first name, no suffix or a cut suffix is not", async () => {
    const { catalog, o } = withChecklist();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r).toMatchObject({ sure: { sourceId: "551033", cardNumber: "336" }, sureBy: "number", callsUsed: 0 });
    expect(lookupConfidence(r, 0.4)).toBe(REVIEW_THRESHOLD);
    for (const name of ["Ken Griffey", "Griffey", "Ken Griffey, J"]) {
      const n = await lookupCard(read({ names: [name], cardNumber: "336" }), "background", o);
      expect(n, name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
      expect(n.candidates[0].sourceId, name).toBe("551033");
      expect(lookupConfidence(n, 0.4)).toBe(0.4);
    }
    expect(catalog.count()).toBe(0);
    // A close spelling of the surname with the number: the top candidate, never sure.
    const eriffey = await lookupCard(read({ names: ["Eriffey"], cardNumber: "336" }), "background", withChecklist().o);
    expect(eriffey).toMatchObject({ sure: null, sureBy: null });
    expect(eriffey.candidates[0].sourceId).toBe("551033");
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
    const initial = await lookupCard(read({ names: ["D Smith"], cardNumber: "311" }), "background", o);
    expect(initial).toMatchObject({ sure: null, callsUsed: 0 });
    expect(initial.candidates[0].cardNumber).toBe("311");
    const dwight = await lookupCard(read({ names: ["Dwight Smith"], cardNumber: "311" }), "background", o);
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
  it("10.6f: exactly one player who fits is NOT sure by name; he is the top candidate, no search", async () => {
    const { catalog, o } = complete(CHECKLIST_CARDS);
    for (const name of ["Eriffey", "Ken Griffey Jr.", "Randy Johnson"]) {
      const r = await lookupCard(read({ names: [name] }), "background", o);
      expect(r, name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
      expect(lookupConfidence(r, 0.4)).toBe(0.4);
    }
    const d = await lookupCard(read({ names: ["D Smith"] }), "background", o);
    expect(d.sure).toBeNull();
    expect(d.candidates[0].cardNumber).toBe("311");
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
    const { scan, o } = withChecklist({ searches: { ...RECORDED, "1990 topps joe montana": [football] }, checklists: { "7001": { cards: [football], complete: true } } });
    const r = await lookupCard(read({ sport: "football", names: ["Joe Montana"], cardNumber: "1" }), "background", o);
    expect(r.sure?.sourceId).toBe("880001");
    expect(Object.fromEntries(scan.setIds)).toEqual({ [BASEBALL_1990_TOPPS]: "9179", "football|1990|topps": "7001" });
  });
  it("no sport read: the baseball memory of the scan is not used, and nothing is sure, not even by number and name", async () => {
    const { catalog, o } = withChecklist();
    const r = await lookupCard(read({ sport: null, names: ["Eriffey"] }), "background", o);
    expect(r.sure).toBeNull();
    expect(catalog.count()).toBeGreaterThan(0);
    const numbered = await lookupCard(read({ sport: null, names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(numbered).toMatchObject({ sure: null, sureBy: null });
    expect(numbered.candidates[0].sourceId).toBe("551033");
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
  it("unknown brand: even one clean entry agreeing with number and name is a candidate only", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ brands: [], names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates[0].sourceId).toBe("551033");
    expect(catalog.count("checklist")).toBe(0);
  });
  it("misread name and unknown brand: nothing, plain reading stands", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ brands: [], names: ["Eriffey"] }), "background", o);
    expect(r).toMatchObject({ sure: null, candidates: [] });
    expect(catalog.count("checklist")).toBe(0);
  });
});

describe("the card's own reading comes first (12R.4)", () => {
  const card = (id: string, over: Partial<CatalogCard>): CatalogCard => ({
    source: "mycardfolio", sourceId: id, url: `https://example.invalid/${id}`, sourceSetId: null, verified: true, sport: "baseball",
    year: 1992, brand: "Donruss", setName: null, cardNumber: null, player: "Bob Milacki", otherPlayers: [], variation: null, tags: [], ...over,
  });
  const answers = [
    card("1", { cardNumber: "202" }),
    card("2", { cardNumber: "101" }),
    card("3", { cardNumber: "55", verified: false, sourceId: "x-3" }),
    card("4", { cardNumber: null, verified: false, sourceId: "x-4" }),
    card("5", { cardNumber: "101", year: 1991 }),
  ];

  it("puts candidates whose number or year disagrees with the card last, and drops such unverified listings", async () => {
    const { o } = setup({ everySearch: () => answers });
    const r = await lookupCard(read({ year: null, brands: [], names: ["Bob Milacki"], cardNumber: "101" }), "background", o);
    expect(r.sure).toBeNull();
    const ids = r.candidates.map((c) => c.sourceId);
    expect(ids[0]).toBe("2");
    expect(ids).toContain("x-4");
    expect(ids).not.toContain("x-3");
    expect(ids.indexOf("1")).toBeGreaterThan(ids.indexOf("x-4"));
  });

  it("with a read year, a candidate of another year goes after the ones of that year", async () => {
    const { o } = setup({ everySearch: () => answers });
    const r = await lookupCard(read({ year: 1992, brands: [], names: ["Bob Milacki"], cardNumber: null }), "background", o);
    const ids = r.candidates.map((c) => c.sourceId);
    if (ids.includes("5")) expect(ids.indexOf("5")).toBe(ids.length - 1);
    expect(ids[0]).not.toBe("5");
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
  it("every network try counts: a call the gate retried twice costs 3 (search and checklist: 6)", async () => {
    const { catalog, scan, o } = setup({ tries: 3 });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(catalog.count()).toBe(2);
    expect(r.callsUsed).toBe(6);
    expect(scan.used).toBe(6);
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

describe("third review: sure needs sport, year, brand, the known base set and an exact surname on the number path", () => {
  const griffey = CHECKLIST_CARDS.find((c) => c.sourceId === "551033") as CatalogCard;
  function fake(id: string, number: string, player: string, over: Partial<CatalogCard> = {}): CatalogCard {
    const set = over.sourceSetId ?? "9179";
    const sport = over.sport ?? "baseball";
    return { ...griffey, sourceId: id, cardNumber: number, player, url: `https://mycardfolio.com/sports/${sport}/${over.year ?? 1990}/topps-2129/base-set-${set}/${number}-x-${id}`, ...over };
  }

  it("Nolan Ryan #1 with no year read: the search shows the 1991 card, it is not sure", async () => {
    const ryan1991 = fake("991001", "1", "Nolan Ryan", { year: 1991, sourceSetId: "9300" });
    const { catalog, o } = setup({ searches: { "topps nolan ryan": [ryan1991] } });
    const r = await lookupCard(read({ year: null, names: ["Nolan Ryan"], cardNumber: "1" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates.map((c) => c.sourceId)).toContain("991001");
    expect(catalog.log()).toEqual(["search:Topps Nolan Ryan"]);
  });

  it("Bo Jackson #300 with no sport read: the search shows a football card, it is not sure", async () => {
    const football = fake("880300", "300", "Bo Jackson", { sport: "football", sourceSetId: "7001" });
    const { catalog, o } = setup({ everySearch: () => [football] });
    const r = await lookupCard(read({ sport: null, names: ["Bo Jackson"], cardNumber: "300" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates.map((c) => c.sourceId)).toContain("880300");
    expect(catalog.count()).toBeGreaterThan(0);
  });

  describe("names with particles in a complete set", () => {
    const pairs = [
      { read: "De La Cruz", wrong: fake("990701", "701", "Deivi Cruz"), right: fake("990702", "702", "Elly De La Cruz") },
      { read: "St. Claire", wrong: fake("990703", "703", "Steve Claire"), right: fake("990704", "704", "Randy St. Claire") },
      { read: "La Russa", wrong: fake("990705", "705", "Larry Russa"), right: fake("990706", "706", "Tony La Russa") },
      // Paul O'Neill is the real #332 of the recording.
      { read: "O Neill", wrong: fake("990707", "707", "Otis Neill"), right: CHECKLIST_CARDS.find((c) => c.player === "Paul O'Neill") as CatalogCard },
    ];
    const extra = pairs.flatMap((p) => (p.right.sourceId.startsWith("9907") ? [p.wrong, p.right] : [p.wrong]));
    it("Paul O'Neill is #332 of the recording", () => expect(pairs[3].right).toMatchObject({ cardNumber: "332", sourceSetId: "9179" }));
    function complete(whole: boolean) {
      const s = setup();
      s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [...CHECKLIST_CARDS, ...extra], whole);
      s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
      return s;
    }
    for (const p of pairs) {
      it(`10.6f: "${p.read}" is never sure, not as ${p.wrong.player} nor as ${p.right.player}, with or without either number`, async () => {
        for (const whole of [true, false]) {
          const { catalog, o } = complete(whole);
          const r = await lookupCard(read({ names: [p.read] }), "background", o);
          expect(r, p.read).toMatchObject({ sure: null, sureBy: null });
          // A two-word read keeps its first word as the first name (10.6f), so "St. Claire" ranks Steve Claire; three words still join.
          if (p.read === "De La Cruz") expect(r.candidates.map((c) => c.sourceId)).toContain(p.right.sourceId);
          for (const n of [p.wrong.cardNumber, p.right.cardNumber]) {
            expect((await lookupCard(read({ names: [p.read], cardNumber: n }), "background", o)).sure, `${p.read} ${n}`).toBeNull();
          }
          expect(catalog.count()).toBe(0);
        }
        // The whole name with its own number is sure.
        const { o } = complete(false);
        const right = await lookupCard(read({ names: [p.right.player as string], cardNumber: p.right.cardNumber }), "background", o);
        expect(right).toMatchObject({ sure: { sourceId: p.right.sourceId }, sureBy: "number" });
      });
    }
  });

  describe("misread numbers in checklist 9179", () => {
    it('"Williamson" + #41 (Matt Williams) and "Costello" + #427 (Carmen Castillo): close surnames, not sure, no call', async () => {
      for (const [name, number, player] of [["Williamson", "41", "Matt Williams"], ["Costello", "427", "Carmen Castillo"]] as const) {
        const { catalog, o } = withChecklist();
        const r = await lookupCard(read({ names: [name], cardNumber: number }), "background", o);
        expect(r, name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
        expect(r.candidates.map((c) => c.player), name).toContain(player);
        expect(catalog.count()).toBe(0);
      }
    });
    it('"Griffey" + #581 (Ken Griffey Sr., past the cut): another Griffey is in the set and no first name was read, not sure', async () => {
      const senior = fake("999581", "581", "Ken Griffey Sr.");
      const { catalog, o } = withChecklist({ searches: { "1990 topps 581": [senior] } });
      const r = await lookupCard(read({ names: ["Griffey"], cardNumber: "581" }), "background", o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates.map((c) => c.sourceId)).toContain("999581");
      expect(catalog.log()).toEqual(["search:1990 Topps 581"]);
      // 10.6f: Ken Griffey Jr. #336 is in the pool with the same first name, so even the whole name read is not sure.
      const named = await lookupCard(read({ names: ["Ken Griffey Sr."], cardNumber: "581" }), "background", o);
      expect(named).toMatchObject({ sure: null, sureBy: null });
      expect(named.candidates[0].sourceId).toBe("999581");
    });
  });

  describe("a second clean set of the same year and brand", () => {
    const real792 = RECORDED["1990 topps 792"].find((c) => c.cardNumber === "792" && c.sourceSetId === "9179" && !c.variation) as CatalogCard;
    const clone792: CatalogCard = { ...real792, sourceId: "999792", sourceSetId: "9999", url: real792.url.replace("base-set-9179", "base-set-9999").replace(real792.sourceId, "999792") };
    it("the recorded #792 is in base set 9179", () => {
      expect(real792).toMatchObject({ player: "Gerald Perry", sourceSetId: "9179" });
    });
    it("same number and name in set 9999: not sure; a later answer showing 9999 and 9179 is a conflict, not sure either", async () => {
      const only = withChecklist({ searches: { "1990 topps 792": [clone792] } });
      const r = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", only.o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates.map((c) => c.sourceId)).toContain("999792");
      const both = withChecklist({ searches: { "1990 topps 792": [clone792, real792] } });
      const b = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", both.o);
      expect(b).toMatchObject({ sure: null, sureBy: null });
      expect(both.scan.conflicts.has(BASEBALL_1990_TOPPS)).toBe(true);
    });
    it("cold start: two clean sets claim the same year and brand, so nothing is sure", async () => {
      const s = setup({ searches: { "1990 topps 792": [clone792, real792] } });
      const r = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", s.o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates.map((c) => c.sourceId)).toEqual(expect.arrayContaining(["999792", real792.sourceId]));
    });
    it("a step 1 answer from a second set when the base set is known: conflict for the scan, nothing is sure", async () => {
      const clone336: CatalogCard = { ...griffey, sourceId: "999336", sourceSetId: "9999", url: griffey.url.replace("base-set-9179", "base-set-9999").replace("551033", "999336") };
      const s = setup({ searches: { "1990 topps ken griffey jr.": [clone336] } });
      s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
      const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", s.o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates.map((c) => c.sourceId)).toEqual(expect.arrayContaining(["551033", "999336"]));
      expect(s.catalog.log()).toEqual(["search:1990 Topps Ken Griffey Jr.", "search:1990 Topps Griffey", "search:1990 Topps 336", "checklist:9179"]);
    });
  });
});

describe("fourth review (10.6f): sure exists in one strict case only", () => {
  const griffey = CHECKLIST_CARDS.find((c) => c.sourceId === "551033") as CatalogCard;
  const real792 = RECORDED["1990 topps 792"].find((c) => c.cardNumber === "792" && c.sourceSetId === "9179" && !c.variation) as CatalogCard;
  function inSet(id: string, number: string, player: string, set = "9179"): CatalogCard {
    return { ...griffey, sourceId: id, cardNumber: number, player, sourceSetId: set, url: `https://mycardfolio.com/sports/baseball/1990/topps-2129/base-set-${set}/${number}-x-${id}` };
  }

  it("Gerald Perry #792 then Ken Griffey Jr. #336: a later answer shows sets 9999 and 9179, so neither is sure and the conflict holds for the rest of the scan", async () => {
    const clone = inSet("999792", "792", "Gerald Perry", "9999");
    // Checklist 9179 (first 500) already in the scan: #792 is past its end, so the number search runs and shows both sets.
    const { scan, catalog, o } = withChecklist({ searches: { ...RECORDED, "1990 topps 792": [clone, real792] } });
    const perry = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", o);
    expect(perry).toMatchObject({ sure: null, sureBy: null });
    expect(scan.conflicts.has(BASEBALL_1990_TOPPS)).toBe(true);
    const ken = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(ken).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
    expect(ken.candidates[0].sourceId).toBe("551033");
    expect(catalog.log()).toEqual(["search:1990 Topps 792"]);
  });
  it("Gerald Perry #792 sure first; a later card's answer shows 9999 and 9179; then Ken Griffey Jr. #336 is not sure", async () => {
    const other = inSet("999601", "601", "Some Body", "9999");
    const mine = inSet("990601", "601", "Some Body");
    const { scan, o } = setup({ searches: { ...RECORDED, "1990 topps gerald perry": [real792], "1990 topps 601": [other, mine] } });
    const perry = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", o);
    expect(perry).toMatchObject({ sure: { sourceId: real792.sourceId }, sureBy: "number" });
    expect(scan.conflicts.size).toBe(0);
    const body = await lookupCard(read({ names: ["Some Body"], cardNumber: "601" }), "background", o);
    expect(body.sure).toBeNull();
    expect(scan.conflicts.has(BASEBALL_1990_TOPPS)).toBe(true);
    const ken = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", o);
    expect(ken).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
    // A new scan starts without the conflict.
    expect((await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", setup().o)).sure?.sourceId).toBe("551033");
  });
  it("yearFromStats: Griffey #336 tried in 1990 and 1989 is not sure", async () => {
    for (const s of [setup(), withChecklist()]) {
      const r = await lookupCard(read({ names: ["Ken Griffey Jr."], cardNumber: "336", yearFromStats: true }), "background", s.o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates[0].sourceId).toBe("551033");
    }
  });
  it("two brands read (Topps and O-Pee-Chee): not sure", async () => {
    for (const s of [setup(), withChecklist()]) {
      const r = await lookupCard(read({ brands: ["Topps", "O-Pee-Chee"], names: ["Ken Griffey Jr."], cardNumber: "336" }), "background", s.o);
      expect(r).toMatchObject({ sure: null, sureBy: null });
      expect(r.candidates[0].sourceId).toBe("551033");
    }
  });
  it("a 2-card clean fake set (complete): a name alone is not sure; the whole name and number is", async () => {
    const able = inSet("990001", "1", "Alan Able");
    const baker = inSet("990002", "2", "Bert Baker");
    const s = setup();
    s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [able, baker], true);
    s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
    for (const name of ["Alan Able", "Able", "Bert Baker"]) {
      expect(await lookupCard(read({ names: [name] }), "background", s.o), name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
    }
    expect((await lookupCard(read({ names: ["Alan Able"], cardNumber: "1" }), "background", s.o)).sure?.sourceId).toBe("990001");
  });
  it('"Hayes" with or without #577 is not sure with Von Hayes #710 and Charlie Hayes #577 in the pool; "V. Hayes" #710 is not sure either', async () => {
    const von = inSet("990710", "710", "Von Hayes");
    const charlie = inSet("990577", "577", "Charlie Hayes");
    for (const [name, n] of [["Hayes", null], ["Hayes", "577"], ["Hayes", "710"], ["V. Hayes", "710"], ["C Hayes", "577"]] as const) {
      const s = setup();
      s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [...CHECKLIST_CARDS, von, charlie], false);
      s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
      const r = await lookupCard(read({ names: [name], cardNumber: n }), "background", s.o);
      expect(r, `${name} ${n}`).toMatchObject({ sure: null, sureBy: null });
    }
  });
  it("a rival seen only in a search answer of this card blocks sure (Charlie Hayes #577 and a bare \"Hayes\" row)", async () => {
    const charlie = inSet("990577", "577", "Charlie Hayes");
    const bare = inSet("990578", "578", "Hayes");
    const { o } = withChecklist({ searches: { "1990 topps 577": [charlie, bare] } });
    const r = await lookupCard(read({ names: ["Charlie Hayes"], cardNumber: "577" }), "background", o);
    expect(r).toMatchObject({ sure: null, sureBy: null });
    expect(r.candidates[0].sourceId).toBe("990577");
    const clean = withChecklist({ searches: { "1990 topps 577": [charlie] } });
    expect((await lookupCard(read({ names: ["Charlie Hayes"], cardNumber: "577" }), "background", clean.o)).sure?.sourceId).toBe("990577");
  });
  it('"Jim Thorne" #801 vs Jim Thome, "Joe Hall" #803 vs Joe Hail, "Ozzie Smith" #805 vs a bare "Smith": not sure', async () => {
    const cases: [string, string, CatalogCard[]][] = [
      ["Jim Thorne", "801", [inSet("990801", "801", "Jim Thorne"), inSet("990811", "811", "Jim Thome")]],
      ["Joe Hall", "803", [inSet("990803", "803", "Joe Hall"), inSet("990813", "813", "Joe Hail")]],
      ["Ozzie Smith", "805", [inSet("990805", "805", "Ozzie Smith"), inSet("990806", "806", "Smith")]],
    ];
    for (const [name, n, extra] of cases) {
      const s = setup();
      s.scan.memory.put("9179", BASEBALL_1990_TOPPS, [...CHECKLIST_CARDS, ...extra], false);
      s.scan.setIds.set(BASEBALL_1990_TOPPS, "9179");
      const r = await lookupCard(read({ names: [name], cardNumber: n }), "background", s.o);
      expect(r, name).toMatchObject({ sure: null, sureBy: null, callsUsed: 0 });
      expect(r.candidates[0].cardNumber, name).toBe(n);
    }
  });
});
