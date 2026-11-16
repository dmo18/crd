import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, catalogCards, catalogSources, items, type NewItem } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";

let owner = true;
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect ${to}`); }
}
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Redirected("/login"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirected(to); } }));

const actions = await import("./actions");
const { FAILURE_MESSAGES } = await import("./messages");
const { setCatalogForTests } = await import("./provider");
import type { Catalog, CatalogCard, CatalogResult } from "./types";

const griffey: CatalogCard = {
  source: "mycardfolio", sourceId: "551033", url: "https://mycardfolio.com/cards/551033", sourceSetId: "9179",
  verified: true, sport: "baseball", year: 1990, brand: "Topps", setName: null, cardNumber: "336",
  player: "Ken Griffey Jr.", otherPlayers: [], variation: null, tags: [],
};
const noisy: CatalogCard = { ...griffey, sourceId: "ab12_x", url: "https://mycardfolio.com/cards/ab12_x", verified: false, sport: "basketball", year: 1986, brand: "Fleer", cardNumber: "57", player: "Michael Jordan" };

let db: Db;
let searchAnswer: CatalogResult<CatalogCard[]>;
let cardAnswer: CatalogResult<CatalogCard | null>;
const calls: { search: unknown[]; card: string[] } = { search: [], card: [] };
const fake: Catalog = {
  async search(q, line) { calls.search.push({ q, line }); return searchAnswer; },
  async card(id, line) { calls.card.push(`${id}:${line}`); return cardAnswer; },
  async checklist() { return { ok: false, reason: "failed" }; },
};
const idle: import("./actions").SearchState = { status: "idle", message: null, rows: [], asked: null };
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Redirected ? e.to : (() => { throw e; })(); }
}
const insertItem = (over: Partial<NewItem> = {}) => db.insert(items).values({ kind: "card", title: "Old", ...over }).returning({ id: items.id }).get().id;

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  owner = true;
  calls.search = []; calls.card = [];
  searchAnswer = { ok: true, value: [griffey], fromStore: false };
  cardAnswer = { ok: true, value: griffey, fromStore: false };
  setCatalogForTests(fake);
});
afterEach(() => { setDbForTests(undefined); setCatalogForTests(undefined); });

describe("search", () => {
  it("is refused without a session and makes no call", async () => {
    owner = false;
    await expect(actions.searchCardsAction(idle, form({ q: "griffey" }))).rejects.toThrow(/login/);
    expect(calls.search).toHaveLength(0);
  });
  it("refuses bad input", async () => {
    for (const bad of <Record<string, string>[]>[{ q: "a" }, { q: "x".repeat(81) }, { q: "griffey", year: "19" }, { q: "griffey", year: "1200" }, { q: "griffey", sport: "chess" }]) {
      const r = await actions.searchCardsAction(idle, form(bad));
      expect(r.status).toBe("error");
    }
    expect(calls.search).toHaveLength(0);
  });
  it("searches in the now line, lists clean rows first and stores nothing", async () => {
    searchAnswer = { ok: true, value: [noisy, griffey], fromStore: false };
    const r = await actions.searchCardsAction(idle, form({ q: " 1990 Topps Griffey ", sport: "baseball", year: "1990" }));
    expect(calls.search).toEqual([{ q: { text: "1990 Topps Griffey", sport: "baseball", year: 1990, limit: 20 }, line: "now" }]);
    expect(r.rows.map((x) => x.verified)).toEqual([true, false]);
    expect(r.rows[0].line).toBe("1990 Topps #336 Ken Griffey Jr.");
    expect(db.select().from(catalogCards).all()).toHaveLength(0);
  });
  it("says nothing found as an empty list", async () => {
    searchAnswer = { ok: true, value: [], fromStore: false };
    const r = await actions.searchCardsAction(idle, form({ q: "eriffey" }));
    expect(r).toMatchObject({ status: "done", rows: [], asked: "eriffey" });
  });
  it("shows a plain line for off, paused, cap, busy and failed", async () => {
    for (const reason of ["off", "paused", "cap", "busy", "failed"] as const) {
      searchAnswer = { ok: false, reason };
      const r = await actions.searchCardsAction(idle, form({ q: "griffey" }));
      expect(r.status).toBe("error");
      expect(r.message).toBe(FAILURE_MESSAGES[reason]);
      expect(r.message).not.toMatch(/[–—]/);
    }
  });
});

describe("add to my collection", () => {
  const add = (fields: Record<string, string>) => actions.addCatalogCardAction({ message: null }, form(fields));

  it("is refused without a session", async () => {
    owner = false;
    await expect(add({ sourceId: "551033" })).rejects.toThrow(/login/);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
  it("refuses a bad source id and a bad item id", async () => {
    expect((await add({ sourceId: "../x" })).message).toBeTruthy();
    expect((await add({ sourceId: "" })).message).toBeTruthy();
    expect((await add({ sourceId: "551033", itemId: "abc" })).message).toMatch(/no longer/);
    expect((await add({ sourceId: "551033", itemId: "999" })).message).toMatch(/no longer/);
    expect(calls.card).toHaveLength(0);
  });
  it("adding twice gives one catalog card, one source row and two items; fields are marked catalog", async () => {
    expect(await redirectOf(add({ sourceId: "551033" }))).toMatch(/^\/items\/\d+$/);
    expect(await redirectOf(add({ sourceId: "551033" }))).toMatch(/^\/items\/\d+$/);
    expect(db.select().from(catalogCards).all()).toHaveLength(1);
    expect(db.select().from(catalogSources).all()).toHaveLength(1);
    const rows = db.select().from(items).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "card", status: "confirmed", quantity: 1, title: "1990 Topps #336 Ken Griffey Jr.", player: "Ken Griffey Jr.", year: 1990 });
    expect(JSON.parse(rows[0].fieldSources!)).toEqual({ sport: "catalog", year: "catalog", brand: "catalog", cardNumber: "catalog", player: "catalog" });
    expect(rows[0].catalogCardId).toBe(rows[1].catalogCardId);
    expect(db.select().from(auditEvents).where(eq(auditEvents.event, "catalog_card_added")).all()).toHaveLength(2);
  });
  it("takes the card from the server's answer, not from browser fields", async () => {
    await redirectOf(add({ sourceId: "551033", player: "Someone Else", year: "1999", brand: "Fake" }));
    expect(calls.card).toEqual(["551033:now"]);
    expect(db.select().from(catalogCards).get()).toMatchObject({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", verified: true });
  });
  it("does not add an unverified listing until the details are confirmed", async () => {
    cardAnswer = { ok: true, value: noisy, fromStore: false };
    expect((await add({ sourceId: "ab12_x" })).message).toMatch(/unverified/i);
    expect(db.select().from(items).all()).toHaveLength(0);
    expect(db.select().from(catalogCards).all()).toHaveLength(0);
    expect(await redirectOf(add({ sourceId: "ab12_x", readDetails: "on" }))).toMatch(/^\/items\//);
    expect(db.select().from(catalogCards).get()?.verified).toBe(false);
  });
  it("refuses a listing without enough facts", async () => {
    cardAnswer = { ok: true, value: { ...griffey, player: null }, fromStore: false };
    expect((await add({ sourceId: "551033" })).message).toMatch(/missing facts/);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
  it("shows plain lines when the catalog cannot answer and when the card is gone", async () => {
    cardAnswer = { ok: false, reason: "paused" };
    expect((await add({ sourceId: "551033" })).message).toBe(FAILURE_MESSAGES.paused);
    cardAnswer = { ok: true, value: null, fromStore: false };
    expect((await add({ sourceId: "551033" })).message).toMatch(/no longer has/);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
});

describe("this is my card (link)", () => {
  it("keeps the owner's words and fills the empty fields", async () => {
    const id = insertItem({ player: "Junior", team: "Mariners", fieldSources: JSON.stringify({ player: "owner", team: "owner" }) });
    const to = await redirectOf(actions.addCatalogCardAction({ message: null }, form({ sourceId: "551033", itemId: String(id) })));
    expect(to).toBe(`/items/${id}`);
    const row = db.select().from(items).where(eq(items.id, id)).get()!;
    expect(row).toMatchObject({ player: "Junior", team: "Mariners", year: 1990, cardNumber: "336", brand: "Topps" });
    expect(row.catalogCardId).not.toBeNull();
    expect(db.select().from(items).all()).toHaveLength(1);
    expect(db.select().from(auditEvents).where(eq(auditEvents.event, "catalog_card_linked")).all()).toHaveLength(1);
  });
  it("refuses an item that already has a catalog link, and changes nothing", async () => {
    const id = insertItem({ player: "Junior" });
    await redirectOf(actions.addCatalogCardAction({ message: null }, form({ sourceId: "551033", itemId: String(id) })));
    const before = db.select().from(items).where(eq(items.id, id)).get()!;
    const r = await actions.addCatalogCardAction({ message: null }, form({ sourceId: "551033", itemId: String(id) }));
    expect(r.message).toBe("This item is already linked. Unlink it first.");
    expect(db.select().from(items).where(eq(items.id, id)).get()).toEqual(before);
  });
  it("refuses an item that is not a single card", async () => {
    const id = insertItem({ kind: "bulk" });
    const r = await actions.addCatalogCardAction({ message: null }, form({ sourceId: "551033", itemId: String(id) }));
    expect(r.message).toMatch(/single card/);
    expect(calls.card).toHaveLength(0);
  });
});
