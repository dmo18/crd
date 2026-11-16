import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, catalogCards, items, type Item } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";
import type { Candidate } from "@/lib/catalog/match";
import { recognizedItemSchema } from "@/lib/recognition/types";
import { FakeCatalog } from "../../../tests/helpers/fake-catalog";

let owner = true;
vi.mock("@/lib/auth/guard", () => ({
  isOwner: async () => owner,
  requireOwner: async () => { if (!owner) throw new Error("redirect /login"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));

const actions = await import("./review-actions");
const { setCatalogForTests } = await import("@/lib/catalog/provider");
const { serializeCatalog, parseCatalog, CANDIDATE_DAYS } = await import("@/lib/catalog/candidates");
const pick = await import("@/lib/catalog/pick");
const { itemFromRecognition } = await import("./from-recognition");
const { confirmItem } = await import("./update");
const { applyBulk, undoBulk } = await import("./bulk");

const T0 = new Date("2026-11-16T10:00:00Z");
const griffey: Candidate = {
  source: "mycardfolio", sourceId: "551033", url: "https://mycardfolio.com/sports/baseball/topps/1990/base-set-9179/551033", sourceSetId: "9179",
  verified: true, sport: "baseball", year: 1990, brand: "Topps", setName: null, cardNumber: "336", player: "Ken Griffey Jr.",
  otherPlayers: [], variation: null, tags: [], score: 3, why: "Name agrees",
};
const senior: Candidate = { ...griffey, sourceId: "551885", cardNumber: "581", player: "Ken Griffey Sr." };
const extra = (n: number): Candidate => ({ ...griffey, sourceId: String(552000 + n), cardNumber: String(100 + n), player: `Player ${n}` });

let db: Db;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
const marks = (row: Item) => JSON.parse(row.fieldSources ?? "null");
function form(fields: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
}
/** An item as a scan files it: read fields marked `reading`, candidates stored, waiting in Review. */
function scanned(read: Record<string, unknown>, candidates: Candidate[] = [griffey, senior]): Item {
  const r = { ...recognizedItemSchema.parse({ kind: "card", confidence: 0.5, ...read }), catalog: { status: "candidates" as const, candidates } };
  const row = itemFromRecognition(r, { scanId: null as unknown as number, locationId: null, valueSource: "ai_estimate", now: new Date(), recognizer: "free" });
  return get(db.insert(items).values(row).returning({ id: items.id }).get().id);
}
const audit = () => db.select().from(auditEvents).all().map((a) => a.event);

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  pick.resetLookupLimitForTests();
  owner = true;
});
afterEach(() => { setDbForTests(undefined); setCatalogForTests(undefined); });

describe("This is my card (one tap pick in Review)", () => {
  it("fills empty fields only, keeps the first suggestion, confirms, clears the list and writes an audit row", async () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps" });
    const r = await actions.pickCandidateAction({ message: null }, form({ id: item.id, position: 0 }));
    expect(r.message).toBeNull();
    const after = get(item.id);
    expect(after).toMatchObject({ cardNumber: "336", sport: "baseball", status: "confirmed", catalogCandidates: null, firstSuggestion: item.firstSuggestion });
    expect(marks(after)).toEqual({ player: "reading", year: "reading", brand: "reading", cardNumber: "catalog", sport: "catalog" });
    expect(after.catalogCardId).toBe(db.select().from(catalogCards).get()!.id);
    expect(audit()).toContain("catalog_card_linked");
  });

  it("never changes an owner field", () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990 });
    db.update(items).set({ brand: "My Topps", fieldSources: JSON.stringify({ ...marks(item), brand: "owner" }) }).where(eq(items.id, item.id)).run();
    const r = pick.pickCandidate(item.id, 0, db);
    expect(r).toMatchObject({ ok: true, differences: [], confirmed: true });
    expect(get(item.id)).toMatchObject({ brand: "My Topps" });
    expect(pick.takeCatalogValues(item.id, {}, db)).toEqual({ ok: true, replaced: [] });
    expect(get(item.id).brand).toBe("My Topps");
  });

  it("lists a reading difference and changes it only through Use the catalog's values", async () => {
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", cardNumber: "33" });
    const r = await actions.pickCandidateAction({ message: null }, form({ id: item.id, position: 0 }));
    expect(r.message).toMatch(/differ/);
    let row = get(item.id);
    expect(row).toMatchObject({ cardNumber: "33", status: "needs_review", catalogCandidates: null });
    const view = pick.reviewCatalogView(row, db)!;
    expect(view.linked?.differences).toEqual([{ label: "number", read: "33", catalog: "336" }]);
    expect(view.candidates).toEqual([]);

    await actions.catalogValuesAction(form({ id: item.id }));
    row = get(item.id);
    expect(row).toMatchObject({ cardNumber: "336", status: "confirmed", firstSuggestion: item.firstSuggestion });
    expect(marks(row).cardNumber).toBe("catalog");
    expect(pick.reviewCatalogView(row, db)!.linked?.differences).toEqual([]);
  });

  it("takes the candidate by its place in the stored list; a place not on the list is refused", async () => {
    const item = scanned({ player: "Ken Griffey" }, [griffey, senior, extra(1)]);
    for (const position of [7, 3, -1, "x"]) {
      const r = await actions.pickCandidateAction({ message: null }, form({ id: item.id, position }));
      expect(r.message).toBe(pick.NOT_ON_LIST);
    }
    expect(get(item.id).catalogCardId).toBeNull();
    expect(pick.pickCandidate(item.id, 7, db)).toEqual({ ok: false, error: pick.NOT_ON_LIST });
    const second = pick.pickCandidate(item.id, 1, db);
    expect(second).toMatchObject({ ok: true });
    expect(get(item.id).cardNumber).toBe("581");
    // Linked now: a second pick is refused.
    expect(pick.pickCandidate(item.id, 0, db)).toEqual({ ok: false, error: pick.ALREADY_LINKED });
  });

  it("is refused without a session", async () => {
    const item = scanned({ player: "Ken Griffey Jr." });
    owner = false;
    await expect(actions.pickCandidateAction({ message: null }, form({ id: item.id, position: 0 }))).rejects.toThrow(/login/);
    await expect(actions.catalogValuesAction(form({ id: item.id }))).rejects.toThrow(/login/);
    await expect(actions.dismissCandidatesAction(form({ id: item.id }))).rejects.toThrow(/login/);
    await expect(actions.lookUpAgainAction({ message: null }, form({ id: item.id }))).rejects.toThrow(/login/);
    expect(get(item.id).catalogCardId).toBeNull();
  });

  it("shows 3 rows and 2 more behind More, unverified listings marked", () => {
    const item = scanned({ player: "Ken Griffey" }, [griffey, senior, extra(1), extra(2), { ...extra(3), verified: false, sourceId: "ebay_1" }, extra(4)]);
    const view = pick.reviewCatalogView(item, db)!;
    expect(view.status).toBe("candidates");
    expect(view.candidates).toHaveLength(5);
    expect(view.candidates[4]).toMatchObject({ position: 4, verified: false });
    expect(view.candidates[0]).toMatchObject({ line: "1990 Topps #336 Ken Griffey Jr.", url: griffey.url });
  });
});

describe("None of these, Confirm and old lists", () => {
  it("None of these clears the list and leaves the reading", async () => {
    const item = scanned({ player: "Ken Griffey" });
    await actions.dismissCandidatesAction(form({ id: item.id }));
    expect(get(item.id)).toMatchObject({ catalogCandidates: null, status: "needs_review", player: "Ken Griffey", catalogCardId: null });
  });

  it("Confirm clears the candidates, also as a bulk change, and undo puts them back", () => {
    const a = scanned({ player: "Ken Griffey" });
    confirmItem(a.id, db);
    expect(get(a.id)).toMatchObject({ status: "confirmed", catalogCandidates: null });
    const b = scanned({ player: "Ken Griffey" });
    const r = applyBulk({ ids: [b.id] }, { type: "status", status: "confirmed" }, db, new Date());
    if ("error" in r) throw new Error(r.error);
    expect(get(b.id).catalogCandidates).toBeNull();
    undoBulk(r.opId, db, new Date());
    expect(get(b.id)).toMatchObject({ status: "needs_review", catalogCandidates: b.catalogCandidates });
  });

  it("a list older than 30 days is not shown", () => {
    const old = serializeCatalog({ status: "candidates", items: [griffey] }, T0);
    expect(parseCatalog(old, new Date(T0.getTime() + (CANDIDATE_DAYS - 1) * 86_400_000))?.items).toHaveLength(1);
    expect(parseCatalog(old, new Date(T0.getTime() + (CANDIDATE_DAYS + 1) * 86_400_000))).toBeNull();
    expect(parseCatalog("not json")).toBeNull();
    expect(parseCatalog(JSON.stringify({ v: 1, at: Date.now(), status: "candidates", reason: null, items: [{ sourceId: "../x" }] }))).toMatchObject({ status: "none", items: [] });
  });

  it("not checked shows its reason in plain words", () => {
    const item = scanned({ player: "Ken Griffey" });
    db.update(items).set({ catalogCandidates: serializeCatalog({ status: "not_checked", reason: "off" }, new Date()) }).where(eq(items.id, item.id)).run();
    const view = pick.reviewCatalogView(get(item.id), db)!;
    expect(view).toMatchObject({ status: "not_checked", reason: "off", candidates: [], canLookUp: true });
  });
});

describe("Look up again", () => {
  it("runs in the now line with the item's fields, stores candidates and fills nothing", async () => {
    const catalog = new FakeCatalog();
    setCatalogForTests(catalog);
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", sport: "baseball" }, []);
    const r = await actions.lookUpAgainAction({ message: null }, form({ id: item.id }));
    expect(r.message).toMatch(/Found/);
    expect(catalog.lines.every((l) => l === "now")).toBe(true);
    const row = get(item.id);
    expect(row.catalogCardId).toBeNull();
    expect(row.cardNumber).toBeNull();
    expect(parseCatalog(row.catalogCandidates)?.items[0]).toMatchObject({ sourceId: "551033" });
  });

  it("is limited to once per 10 seconds per item", async () => {
    const catalog = new FakeCatalog();
    let t = T0.getTime();
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", sport: "baseball" }, []);
    const deps = { db, catalog, now: () => new Date(t) };
    expect(await pick.lookUpAgain(item.id, deps)).toMatchObject({ ok: true });
    const calls = catalog.calls.length;
    t += 9_000;
    expect(await pick.lookUpAgain(item.id, deps)).toEqual({ ok: false, error: pick.LOOKUP_WAIT });
    expect(catalog.calls.length).toBe(calls);
    t += 1_000;
    expect(await pick.lookUpAgain(item.id, deps)).toMatchObject({ ok: true });
  });

  it("needs a player or a number, and a catalog that is off says not checked", async () => {
    const empty = scanned({ year: 1990 }, []);
    expect(await pick.lookUpAgain(empty.id, { db, catalog: new FakeCatalog() })).toEqual({ ok: false, error: pick.LOOKUP_NEEDS });
    const item = scanned({ player: "Ken Griffey Jr.", year: 1990, brand: "Topps", sport: "baseball" }, []);
    expect(await pick.lookUpAgain(item.id, { db, catalog: new FakeCatalog({ fail: "off" }) })).toEqual({ ok: true, found: 0, notChecked: "off" });
    expect(parseCatalog(get(item.id).catalogCandidates)).toMatchObject({ status: "not_checked", reason: "off" });
  });
});

describe("plain words", () => {
  it("has no em or en dashes in the Review catalog texts", async () => {
    const { NOT_CHECKED_LINES } = await import("@/lib/catalog/candidates");
    const texts = [...Object.values(NOT_CHECKED_LINES), pick.NOT_ON_LIST, pick.LOOKUP_WAIT, pick.LOOKUP_NEEDS, pick.ALREADY_LINKED];
    for (const t of texts) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});

