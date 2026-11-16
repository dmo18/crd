import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Catalog, CatalogCard, CatalogFailure, CatalogResult } from "./types";
import { parseChecklist, parseSearch } from "./mycardfolio";
import { CARD_CALLS, CHECK_CONFIDENCE, ChecklistMemory, createScanBudget, lookupCard, lookupConfidence, type LookupRead } from "./lookup";
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
};

class FakeCatalog implements Catalog {
  calls: { tool: "search" | "card" | "checklist"; arg: string }[] = [];
  /** The limit of each search, in order. */
  limits: (number | undefined)[] = [];
  constructor(
    private readonly opts: { fail?: CatalogFailure; searches?: Record<string, CatalogCard[]>; fromStore?: boolean; everySearch?: (text: string) => CatalogCard[] } = {},
  ) {}
  private answer<T>(value: T): CatalogResult<T> {
    return this.opts.fail ? { ok: false, reason: this.opts.fail } : { ok: true, value, fromStore: Boolean(this.opts.fromStore) };
  }
  async search(q: { text: string; limit?: number }) {
    this.calls.push({ tool: "search", arg: q.text });
    this.limits.push(q.limit);
    const key = q.text.toLowerCase();
    return this.answer(this.opts.everySearch?.(key) ?? (this.opts.searches ?? RECORDED)[key] ?? []);
  }
  async card(sourceId: string) {
    this.calls.push({ tool: "card", arg: sourceId });
    return this.answer(null);
  }
  async checklist(sourceSetId: string) {
    this.calls.push({ tool: "checklist", arg: sourceSetId });
    if (sourceSetId === "9179") return this.answer(CHECKLIST as { cards: CatalogCard[]; complete: boolean });
    // Any other set: an empty first page that says it goes on, so the number search runs too.
    return this.answer({ cards: [], complete: false });
  }
  count(tool?: string) {
    return this.calls.filter((c) => !tool || c.tool === tool).length;
  }
}

function read(over: Partial<LookupRead>): LookupRead {
  return { year: 1990, brands: ["Topps"], sport: "baseball", names: [], cardNumber: null, ...over };
}
function setup(opts?: ConstructorParameters<typeof FakeCatalog>[0]) {
  const catalog = new FakeCatalog(opts);
  const scan = createScanBudget();
  const memory = new ChecklistMemory();
  return { catalog, scan, memory, o: { catalog, scan, memory } };
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

  it("name only, number cut off: the checklist of the base set from step 1 decides", async () => {
    const { catalog, o } = setup();
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(r.sureBy).toBe("name");
    expect(catalog.calls.filter((c) => c.tool === "checklist").map((c) => c.arg)).toEqual(["9179"]);
    expect(lookupConfidence(r, 0.4)).toBe(CHECK_CONFIDENCE);
  });

  it('"1990 Topps Eriffey" finds #336 through the checklist; the next card of the set costs no call', async () => {
    const { catalog, scan, o } = setup();
    // An earlier card of the scan: found by its number, which teaches the base set id.
    const witt = await lookupCard(read({ names: ["Mike Witt"], cardNumber: "650" }), "background", o);
    expect(witt.sure?.sourceId).toBe("551347");
    expect(lookupConfidence(witt, 0.4)).toBe(REVIEW_THRESHOLD);

    const before = catalog.count();
    const eriffey = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(eriffey.sure?.sourceId).toBe("551033");
    expect(eriffey.sure?.cardNumber).toBe("336");
    expect(catalog.calls.slice(before).map((c) => `${c.tool}:${c.arg}`)).toEqual(["search:1990 Topps Eriffey", "checklist:9179"]);
    expect(eriffey.callsUsed).toBe(2);

    const used = scan.used;
    const third = await lookupCard(read({ names: ["Ken Griffey, J"] }), "background", o);
    expect(third.sure?.sourceId).toBe("551033");
    expect(third.callsUsed).toBe(0);
    expect(scan.used).toBe(used);
  });

  it('"1990 Topps Eriffey" alone, on a cold start: "1990 Topps 1" (limit 5) teaches the set id and the checklist finds #336', async () => {
    const { catalog, scan, o } = setup();
    const r = await lookupCard(read({ names: ["Eriffey"] }), "background", o);
    expect(r.sure?.sourceId).toBe("551033");
    expect(r.sure?.cardNumber).toBe("336");
    expect(catalog.calls.map((c) => `${c.tool}:${c.arg}`)).toEqual(["search:1990 Topps Eriffey", "search:1990 Topps 1", "checklist:9179"]);
    expect(catalog.limits).toEqual([10, 5]);
    expect(r.callsUsed).toBe(3);
    // Learned for the rest of the scan; the Tiffany card #128 in that answer (set 9181) taught nothing.
    expect([...scan.setIds]).toEqual([["1990|topps", "9179"]]);
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
    expect(found.sure?.sourceId).toBe("551033");
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
    const { catalog, memory, o } = setup();
    memory.put("9179", "1990|topps", (CHECKLIST as { cards: CatalogCard[] }).cards, false);
    const r = await lookupCard(read({ names: ["Gerald Perry"], cardNumber: "792" }), "background", o);
    expect(r.sure).toMatchObject({ cardNumber: "792", player: "Gerald Perry", variation: null });
    expect(catalog.calls.map((c) => c.arg)).toContain("1990 Topps 792");
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
    const r = await lookupCard(read({ brands: ["Topps", "Fleer"], yearFromStats: true, names: ["Xavier Nobody"], cardNumber: "999" }), "background", { catalog, scan: createScanBudget(), memory: new ChecklistMemory() });
    expect(catalog.count()).toBeLessThanOrEqual(CARD_CALLS);
    expect(r.callsUsed).toBe(catalog.count());
    expect(catalog.count("checklist")).toBe(2);
    expect(catalog.calls.map((c) => c.arg)).toContain("1990 Fleer 999");
  });
  it("never more than 40 calls per scan; later cards stop cleanly with the plain reading", async () => {
    const catalog = busyFake();
    const scan = createScanBudget();
    const memory = new ChecklistMemory();
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await lookupCard(read({ year: 1980 + i, brands: ["Topps", "Fleer"], names: [`Player Number${i}`], cardNumber: String(600 + i) }), "background", { catalog, scan, memory }));
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
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", o);
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
  it("a failed call is counted and the look up goes on to the next step", async () => {
    const { catalog, o } = setup({ fail: "failed" });
    const r = await lookupCard(read({ names: ["Ken Griffey Jr."] }), "background", o);
    expect(r.sure).toBeNull();
    expect(r.callsUsed).toBe(catalog.count());
    expect(catalog.count()).toBeGreaterThan(1);
  });
});
