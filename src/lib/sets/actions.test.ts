import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { cardSets, items, wantedCards } from "@/db/schema";
import { parseChecklist } from "@/lib/catalog/mycardfolio";
import type { Catalog } from "@/lib/catalog/types";

let owner = true;
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect ${to}`); }
}
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Redirected("/login"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirected(to); } }));

const { getChecklistAction, toggleWantAction } = await import("./actions");
const { setCatalogForTests } = await import("@/lib/catalog/provider");

const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog/checklist_9179_first500.json"), "utf8"));
const CHECKLIST = parseChecklist(`data: ${JSON.stringify(raw.response)}\n`, "9179")!;
const KEY = "1990_topps__baseball";
let db: Db;
let calls = 0;
const fake: Catalog = {
  async search() { calls += 1; return { ok: true, value: CHECKLIST.cards.slice(335, 336), fromStore: false }; },
  async card() { return { ok: true, value: null, fromStore: false }; },
  async checklist() { calls += 1; return { ok: true, value: CHECKLIST, fromStore: false }; },
};
const form = (f: Record<string, string>) => { const d = new FormData(); for (const [k, v] of Object.entries(f)) d.set(k, v); return d; };
const START = { result: null, error: null };

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  setCatalogForTests(fake);
  owner = true;
  calls = 0;
  db.insert(items).values({ kind: "card", status: "confirmed", title: "Griffey", sport: "baseball", year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." }).run();
});

describe("set actions", () => {
  it("need the owner: nothing is fetched or marked without the session", async () => {
    owner = false;
    await expect(getChecklistAction(START, form({ key: KEY }))).rejects.toThrow("redirect /login");
    await expect(toggleWantAction(form({ key: KEY, number: "1", want: "yes" }))).rejects.toThrow("redirect /login");
    expect(calls).toBe(0);
    expect(db.select().from(cardSets).all()).toEqual([]);
  });

  it("refuse a key that is not a set key", async () => {
    expect(await getChecklistAction(START, form({ key: "../../etc" }))).toEqual({ result: null, error: "This set could not be found." });
    expect(calls).toBe(0);
  });

  it("Get the checklist, then Want: number and player come from the stored list, never from the browser", async () => {
    const r = await getChecklistAction(START, form({ key: KEY }));
    expect(r.result).toMatchObject({ kind: "loaded", entries: 500, complete: false });
    await toggleWantAction(form({ key: KEY, number: "1", want: "yes", player: "Someone Else" }));
    // Not on the stored list, owned, or not a card number: no mark.
    await toggleWantAction(form({ key: KEY, number: "999", want: "yes" }));
    await toggleWantAction(form({ key: KEY, number: "336", want: "yes" }));
    await toggleWantAction(form({ key: KEY, number: "<b>", want: "yes" }));
    expect(db.select().from(wantedCards).all().map((w) => [w.numberKey, w.player])).toEqual([["1", "Nolan Ryan"]]);
    await toggleWantAction(form({ key: KEY, number: "1", want: "yes" }));
    expect(db.select().from(wantedCards).all()).toHaveLength(1);
    await toggleWantAction(form({ key: KEY, number: "1", want: "no" }));
    expect(db.select().from(wantedCards).all()).toEqual([]);
  });
});
