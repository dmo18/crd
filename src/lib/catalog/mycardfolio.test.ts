import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "@/db";
import { createMyCardfolio, parseCard, parseChecklist, parseSearch, readAnswer } from "./mycardfolio";

function fixture(name: string): { response: unknown; arguments: unknown } {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8"));
}
/** The answer as the server sends it: an event stream with one data line. */
function sse(name: string): string {
  return `event: message\ndata: ${JSON.stringify(fixture(name).response)}\n\n`;
}
function wrap(inner: unknown): string {
  const text = typeof inner === "string" ? inner : JSON.stringify(inner);
  return `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id: 1 })}\n\n`;
}
function client(body: string | (() => Response)) {
  const fetchImpl = vi.fn(async () => (typeof body === "string" ? new Response(body, { status: 200 }) : body()));
  return { fetchImpl, catalog: createMyCardfolio({ db: createDb(":memory:"), fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("search", () => {
  it("Griffey: clean 551033 first, no noise", async () => {
    const { catalog, fetchImpl } = client(sse("search_1990_topps_griffey.json"));
    const r = await catalog.search({ text: "1990 Topps Ken Griffey Jr." }, "now");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ sourceId: "551033", verified: true, player: "Ken Griffey Jr.", brand: "Topps", year: 1990, cardNumber: "336", sport: "baseball", sourceSetId: "9179", setName: null });
    expect(r.value.every((c) => c.verified)).toBe(true);
    // The request: POST, JSON-RPC, tool name and exact arguments.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent.params).toEqual({ name: "search_cards", arguments: { query: "1990 Topps Ken Griffey Jr.", limit: 20 } });
  });
  it("Jordan: at most 3 rows, all unverified", async () => {
    const { catalog } = client(sse("search_1986_fleer_jordan_noisy.json"));
    const r = await catalog.search({ text: "1986 Fleer Michael Jordan", sport: "basketball", year: 1986, limit: 5 }, "background");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(0);
    expect(r.value.length).toBeLessThanOrEqual(3);
    expect(r.value.every((c) => !c.verified && c.sourceSetId === null && c.tags.length === 0)).toBe(true);
  });
  it("sends sport and year as the site wants them", async () => {
    const { catalog, fetchImpl } = client(sse("search_1990_topps_griffey.json"));
    await catalog.search({ text: "1990 Topps", sport: "baseball", year: 1990, limit: 50 }, "now");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).params.arguments).toEqual({ query: "1990 Topps", limit: 50, sport: "Baseball", year: "1990" });
  });
  it("a recorded search by number finds Base and Tiffany", async () => {
    const r = parseSearch(sse("search_1990_topps_792.json"));
    expect(r?.map((c) => [c.sourceId, c.variation])).toEqual([["551489", null], ["552341", "Tiffany"]]);
  });
  it("the 1990 Topps search with 50 rows is all noise: at most 3 kept", () => {
    const r = parseSearch(sse("search_1990_topps_sets.json"), 50);
    expect(r?.length).toBeLessThanOrEqual(3);
    expect(r?.every((c) => !c.verified)).toBe(true);
  });
  it("the recorded empty search is a normal nothing and is stored", async () => {
    expect(parseSearch(sse("search_empty_eriffey.json"))).toEqual([]);
    const db = createDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response(sse("search_empty_eriffey.json"), { status: 200 }));
    const c = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.search({ text: "1990 Topps Eriffey" }, "now")).toEqual({ ok: true, value: [], fromStore: false });
    const { outsideCache } = await import("@/db/schema");
    expect(db.select().from(outsideCache).all()).toHaveLength(1);
  });
  it.each(["No results found", "nothing found", "0 cards", "Card not found", "Rate limit exceeded, not found later", ""])(
    "plain text %j is a failure and is not stored",
    async (text) => {
      const db = createDb(":memory:");
      const fetchImpl = vi.fn(async () => new Response(wrap(text), { status: 200 }));
      const c = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(await c.search({ text: "1990 Topps" }, "now")).toEqual({ ok: false, reason: "failed" });
      const { outsideCache } = await import("@/db/schema");
      expect(db.select().from(outsideCache).all()).toHaveLength(0);
    },
  );
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("limit %s falls back to 20", async (limit) => {
    const { catalog, fetchImpl } = client(sse("search_1990_topps_griffey.json"));
    await catalog.search({ text: "1990 Topps", limit }, "now");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).params.arguments.limit).toBe(20);
  });
  it("too short a text makes no call", async () => {
    const { catalog, fetchImpl } = client("x");
    const r = await catalog.search({ text: " a " }, "now");
    expect(r).toEqual({ ok: true, value: [], fromStore: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("card", () => {
  it("gives set id 9179", async () => {
    const { catalog } = client(sse("card_551033.json"));
    const r = await catalog.card("551033", "now");
    expect(r.ok && r.value).toMatchObject({ sourceId: "551033", sourceSetId: "9179", player: "Ken Griffey Jr." });
  });
  it("takes the set id from the set block when the url has none", () => {
    const f = fixture("card_551033.json").response as { result: { content: { text: string }[] } };
    const inner = JSON.parse(f.result.content[0].text);
    inner.card.url = "https://other.example/x/551033";
    const r = parseCard(wrap(inner));
    expect(r?.card?.sourceSetId).toBe("9179");
    expect(r?.card?.url).toBe("https://mycardfolio.com");
  });
  it("keeps at most 10 players and 200 characters, and 60,000 players parse fast", () => {
    const f = fixture("card_551033.json").response as { result: { content: { text: string }[] } };
    const inner = JSON.parse(f.result.content[0].text);
    inner.card.subjects = Array.from({ length: 60_000 }, (_, i) => ({ subject_name: `PLAYER NUMBER${i} ` + "X".repeat(300) }));
    inner.card.product = "Topps " + "y".repeat(1000);
    inner.card.set = "z".repeat(1000);
    const started = Date.now();
    const card = parseCard(wrap(inner))?.card;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(card).toBeTruthy();
    expect(1 + (card?.otherPlayers.length ?? 0)).toBe(10);
    for (const t of [card?.player, ...(card?.otherPlayers ?? []), card?.brand, card?.variation, card?.setName]) {
      expect((t ?? "").length).toBeLessThanOrEqual(200);
    }
    expect(card?.variation?.length).toBe(194);
  });
  it("rebuilds the card link without user, query or hash", () => {
    const f = fixture("card_551033.json").response as { result: { content: { text: string }[] } };
    const inner = JSON.parse(f.result.content[0].text);
    const page = new URL(inner.card.url).pathname;
    inner.card.url = `https://me:secret@mycardfolio.com${page}?utm=x#frag`;
    expect(parseCard(wrap(inner))?.card?.url).toBe("https://mycardfolio.com" + page);
  });
  it("no such card is a normal nothing", async () => {
    const { catalog } = client(wrap("No card found with card_id 1"));
    expect(await catalog.card("1", "now")).toEqual({ ok: true, value: null, fromStore: false });
  });
  it("a bad id makes no call", async () => {
    const { catalog, fetchImpl } = client("x");
    expect(await catalog.card("../x", "now")).toEqual({ ok: true, value: null, fromStore: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checklist", () => {
  it("parses the recording, contains #336, says it is cut at 500", async () => {
    const { catalog } = client(sse("checklist_9179_first500.json"));
    const r = await catalog.checklist("9179", "background");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cards).toHaveLength(500);
    expect(r.value.complete).toBe(false);
    expect(r.value.cards.find((c) => c.cardNumber === "336")).toMatchObject({ sourceId: "551033", player: "Ken Griffey Jr.", sourceSetId: "9179" });
    expect(r.value.cards.every((c) => c.verified)).toBe(true);
  });
  it("a whole set is complete", () => {
    const rows = [1, 2].map((n) => ({ card_id: String(n), sport: "Baseball", year: "1990", product: "Topps", set: "Base Set", card_number: String(n), subjects: [{ subject_name: "A B" }], url: `https://mycardfolio.com/sports/baseball/1990/topps-1/base-set-5/${n}-a-b-${n}` }));
    expect(parseChecklist(wrap({ set: { set_id: "5" }, total_cards: 2, cards: rows }), "5")?.complete).toBe(true);
    expect(parseChecklist(wrap({ set: { set_id: "5" }, total_cards: 3, cards: rows }), "5")?.complete).toBe(false);
  });
  it("an answer for another set is a failure and is not stored", async () => {
    const f = fixture("checklist_9179_first500.json").response as { result: { content: { text: string }[] } };
    const inner = JSON.parse(f.result.content[0].text);
    expect(parseChecklist(wrap(inner), "9180")).toBeNull();
    const db = createDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response(wrap(inner), { status: 200 }));
    const c = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.checklist("9180", "background")).toEqual({ ok: false, reason: "failed" });
    const { outsideCache } = await import("@/db/schema");
    expect(db.select().from(outsideCache).all()).toHaveLength(0);
  });
  it("500 rows with no total and no note still counts as incomplete", () => {
    const f = fixture("checklist_9179_first500.json").response as { result: { content: { text: string }[] } };
    const inner = JSON.parse(f.result.content[0].text);
    delete inner.note;
    delete inner.total_cards;
    expect(parseChecklist(wrap(inner), "9179")?.complete).toBe(false);
    inner.cards = inner.cards.slice(0, 499);
    expect(parseChecklist(wrap(inner), "9179")?.complete).toBe(true);
  });
  it("takes the tags from the recorded checklist", () => {
    const r = parseChecklist(sse("checklist_9179_first500.json"), "9179");
    const byNumber = (n: string) => r?.cards.find((c) => c.cardNumber === n);
    expect(byNumber("6")).toMatchObject({ player: "Vince Coleman", tags: ["RB"] });
    expect(byNumber("314")).toMatchObject({ player: "Donald Harris", tags: ["FDP"] });
    expect(byNumber("444")).toMatchObject({ player: "Kyle Abbott", tags: ["FDP"] });
    expect(byNumber("396")).toMatchObject({ player: "Bart Giamatti", tags: ["MEM"] });
    expect(byNumber("249")).toMatchObject({ player: "Mike (Texas) Smith", tags: [] });
  });
  it("a bad set id makes no call", async () => {
    const { catalog, fetchImpl } = client("x");
    expect((await catalog.checklist("9179/../x", "now")).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("broken answers never throw", () => {
  const cases: [string, string][] = [
    ["no data line", "event: message\n\n"],
    ["empty", ""],
    ["bad outer JSON", "data: {oops\n\n"],
    ["bad inner JSON", wrap("{not json")],
    ["error result", `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } })}\n\n`],
    ["isError", `data: ${JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "boom" }] } })}\n\n`],
    ["wrong shape", wrap({ results: "nope" })],
    ["no content", `data: ${JSON.stringify({ result: {} })}\n\n`],
  ];
  it.each(cases)("%s", async (_n, body) => {
    const { catalog } = client(body);
    for (const r of [await catalog.search({ text: "1990 Topps" }, "now"), await catalog.card("551033", "now"), await catalog.checklist("9179", "now")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("failed");
    }
  });
  it("a broken answer is not kept", async () => {
    const db = createDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response("event: message\n\n", { status: 200 }));
    const c = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.search({ text: "1990 Topps" }, "now");
    const { outsideCache } = await import("@/db/schema");
    expect(db.select().from(outsideCache).all()).toHaveLength(0);
  });
  it("one bad row among good ones is dropped", () => {
    const good = (id: string) => ({ card_id: id, sport: "Baseball", year: "1990", product: "Topps", set: "Base Set", card_number: "1", subjects: [{ subject_name: "A B" }], url: "https://mycardfolio.com/sports/baseball/1990/topps-1/base-set-5/1-a-b-" + id });
    const r = parseSearch(wrap({ results: [good("1"), { nope: true }, 42, null, { card_id: "../x" }, good("2")] }));
    expect(r?.map((c) => c.sourceId)).toEqual(["1", "2"]);
  });
  it("a failed call gives the plain reason", async () => {
    const { catalog } = client(() => new Response("x", { status: 429 }));
    expect(await catalog.search({ text: "1990 Topps" }, "now")).toEqual({ ok: false, reason: "paused" });
  });
  it("readAnswer takes plain JSON too", () => {
    expect(readAnswer(JSON.stringify({ result: { content: [{ type: "text", text: "{\"a\":1}" }] } }))).toEqual({ kind: "json", value: { a: 1 } });
  });
});

describe("stored answers", () => {
  it("the second identical search comes from the store", async () => {
    const db = createDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response(sse("search_1990_topps_griffey.json"), { status: 200 }));
    const c = createMyCardfolio({ db, fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.search({ text: "1990 Topps Ken Griffey Jr." }, "now");
    const r = await c.search({ text: "1990 Topps Ken Griffey Jr." }, "now");
    expect(r.ok && r.fromStore).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
