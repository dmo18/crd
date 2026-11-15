import { describe, expect, it, vi } from "vitest";
import { createDb } from "@/db";
import { playerFacts } from "@/db/schema";
import { lookupPlayer, normalizeName, rankCandidates, type PlayerFacts } from "./wikidata";

const cell = (value: string) => ({ type: "literal", value });
const ent = (id: string) => ({ type: "uri", value: `http://www.wikidata.org/entity/${id}` });

const BIG_HURT = {
  item: ent("Q1"), label: cell("Frank Thomas"), description: cell("American baseball player"),
  sports: cell("baseball"), occupations: cell("baseball player"),
  teams: cell("Chicago White Sox|Oakland Athletics|Toronto Blue Jays"),
  awards: cell("National Baseball Hall of Fame|Silver Slugger Award"),
  start: cell("1990"), end: cell("2008"), birth: cell("1968"),
};
const COACH = {
  item: ent("Q2"), label: cell("Frank Thomas"), description: cell("American football coach"),
  sports: cell("American football"), occupations: cell("American football coach|American football player"),
  teams: cell("Alabama Crimson Tide"), awards: cell("College Football Hall of Fame"),
  start: cell("1925"), end: cell("1946"), birth: cell("1898"),
};
const POLITICIAN = {
  item: ent("Q3"), label: cell("Frank Thomas"), description: cell("Irish politician"),
  occupations: cell("politician"), birth: cell("1950"),
};

function searchBody(ids: string[]) {
  return { search: ids.map((id) => ({ id, label: "Frank Thomas" })) };
}

/** A fake Wikidata: answers the search call and the SPARQL call. */
function fakeFetch(rows: object[], ids = ["Q1", "Q2", "Q3"]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body = url.hostname === "www.wikidata.org" ? searchBody(ids) : { results: { bindings: rows } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const asFetch = (f: unknown) => f as typeof fetch;

describe("normalizeName", () => {
  it("handles accents, punctuation and suffixes", () => {
    expect(normalizeName("  José  O'Neil Jr. ")).toBe("jose o neil");
    expect(normalizeName("Ken Griffey, Sr.")).toBe("ken griffey");
  });
});

describe("lookupPlayer", () => {
  it("picks the baseball player by sport and year, with teams and Hall of Fame", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch([COACH, POLITICIAN, BIG_HURT]);
    const facts = await lookupPlayer("Frank Thomas", { sport: "baseball", year: 1990, db, fetchImpl: asFetch(f) });
    expect(facts).toMatchObject({
      wikidataId: "Q1", sports: ["baseball"], hallOfFame: true, birthYear: 1968, careerStart: 1990, careerEnd: 2008,
    });
    expect(facts?.teams).toContain("Chicago White Sox");
  });

  it("uses only the two Wikidata hosts, a generic User-Agent, and encodes the search text", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch([BIG_HURT]);
    await lookupPlayer("Tom & Jerry #1", { db, fetchImpl: asFetch(f) });
    expect(f).toHaveBeenCalledTimes(2);
    const hosts = f.mock.calls.map((c) => new URL(String(c[0])).hostname);
    expect(hosts).toEqual(["www.wikidata.org", "query.wikidata.org"]);
    const first = String(f.mock.calls[0][0]);
    expect(first).toContain("search=Tom+%26+Jerry+%231");
    expect(new URL(first).searchParams.get("search")).toBe("Tom & Jerry #1");
    expect(first).not.toContain("#");
    for (const call of f.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("CardVault/1.0 (personal sports card collection app)");
      expect(headers["User-Agent"]).not.toMatch(/@/);
      expect(headers.Accept).toBe("application/json");
    }
  });

  it("serves a second lookup from the cache without fetching", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch([BIG_HURT]);
    const a = await lookupPlayer("Frank Thomas", { sport: "baseball", db, fetchImpl: asFetch(f) });
    const b = await lookupPlayer("frank  THOMAS", { sport: "baseball", db, fetchImpl: asFetch(f) });
    expect(f).toHaveBeenCalledTimes(2);
    expect(b).toEqual(a);
    expect(db.select().from(playerFacts).all()[0].key).toBe("frank thomas|baseball");
  });

  it("caches a miss and reuses it, then refetches after 90 days", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch([POLITICIAN]);
    const now = new Date("2026-01-01T00:00:00Z");
    expect(await lookupPlayer("Frank Thomas", { db, now, fetchImpl: asFetch(f) })).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    expect(db.select().from(playerFacts).all()[0].facts).toBeNull();
    expect(await lookupPlayer("Frank Thomas", { db, now, fetchImpl: asFetch(f) })).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    const later = new Date(now.getTime() + 91 * 86_400_000);
    await lookupPlayer("Frank Thomas", { db, now: later, fetchImpl: asFetch(f) });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("returns null and does not cache when the network fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: Record<string, typeof fetch> = {
      network: asFetch(vi.fn(async () => { throw new TypeError("fetch failed"); })),
      http500: asFetch(vi.fn(async () => new Response("oops", { status: 500 }))),
      badJson: asFetch(vi.fn(async () => new Response("<html>not json", { status: 200 }))),
      badShape: asFetch(vi.fn(async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 }))),
    };
    for (const fetchImpl of Object.values(cases)) {
      const db = createDb(":memory:");
      expect(await lookupPlayer("Frank Thomas", { db, fetchImpl })).toBeNull();
      expect(db.select().from(playerFacts).all()).toHaveLength(0);
    }
    for (const call of warn.mock.calls) expect(String(call[0])).toMatch(/^wikidata lookup failed: \w+$/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Frank");
    warn.mockRestore();
  });

  it("times out, returns null and does not cache", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createDb(":memory:");
    const hang = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    expect(await lookupPlayer("Frank Thomas", { db, timeoutMs: 40, fetchImpl: asFetch(hang) })).toBeNull();
    expect(db.select().from(playerFacts).all()).toHaveLength(0);
    warn.mockRestore();
  });

  it("ignores people who are not athletes", async () => {
    const db = createDb(":memory:");
    expect(await lookupPlayer("Frank Thomas", { db, fetchImpl: asFetch(fakeFetch([POLITICIAN])) })).toBeNull();
  });

  it("rejects a card dated before the player was 15", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch([BIG_HURT]);
    expect(await lookupPlayer("Frank Thomas", { year: 1975, db, fetchImpl: asFetch(f) })).toBeNull();
    expect(await lookupPlayer("Frank Thomas", { year: 1983, db, fetchImpl: asFetch(f) })).toMatchObject({ wikidataId: "Q1" });
  });
});

describe("rankCandidates", () => {
  const base: PlayerFacts = {
    name: "Frank Thomas", wikidataId: "Q1", description: null, sports: ["baseball"], teams: [],
    careerStart: 1990, careerEnd: 2008, hallOfFame: false, birthYear: 1968,
  };
  const coach: PlayerFacts = { ...base, wikidataId: "Q2", sports: ["football"], careerStart: 1925, careerEnd: 1946, birthYear: 1898 };

  it("prefers exact names, then sport, then a career covering the year", () => {
    const partial = { ...base, wikidataId: "Q9", name: "Frank Thomas Smith" };
    expect(rankCandidates([partial, coach, base], { name: "Frank Thomas", sport: "baseball", year: 1990 }).map((c) => c.wikidataId))
      .toEqual(["Q1", "Q9", "Q2"]);
    expect(rankCandidates([base, coach], { name: "Frank Thomas", sport: "football", year: 1930 })[0].wikidataId).toBe("Q2");
    expect(rankCandidates([base, coach], { name: "Frank Thomas", year: 1930 })[0].wikidataId).toBe("Q2");
  });

  it("drops names that do not match", () => {
    expect(rankCandidates([base], { name: "Frank Thompson" })).toEqual([]);
  });
});
