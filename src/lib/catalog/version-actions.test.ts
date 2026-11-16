import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, items, type NewItem } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";
import { FakeCatalog, recordedSearch } from "../../../tests/helpers/fake-catalog";

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

const actions = await import("./version-actions");
const versions = await import("./versions");
const { setCatalogForTests } = await import("./provider");
const { serializeCatalog } = await import("./candidates");
const pick = await import("./pick");
const { lookUpAgain } = await import("./pick");

const THOMAS = recordedSearch("versions_1990_topps_414_thomas.json", 20);
const SEARCHES = { "1990 topps 414 thomas": THOMAS };

let db: Db;
let catalog: FakeCatalog;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
const insert = (over: Partial<NewItem> = {}) => db.insert(items).values({
  kind: "card", title: "x", status: "confirmed", sport: "baseball", year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas",
  fieldSources: JSON.stringify({ sport: "reading", year: "reading", brand: "reading", cardNumber: "reading", player: "reading" }), ...over,
}).returning({ id: items.id }).get().id;
function form(fields: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
}
const empty = { message: null };
const audits = () => db.select().from(auditEvents).all();
async function show(id: number) {
  expect(await actions.showVersionsAction(empty, form({ id }))).toEqual({ message: null });
  return versions.parseVersions(get(id).versionOptions)!;
}

beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  versions.resetShowVersionsLimitForTests();
  pick.resetLookupLimitForTests();
  catalog = new FakeCatalog({ searches: SEARCHES });
  setCatalogForTests(catalog);
  owner = true;
});
afterEach(() => { setDbForTests(undefined); setCatalogForTests(undefined); });

describe("version actions", () => {
  it("refuse without the owner's session, and change nothing", async () => {
    const id = insert();
    const v = await show(id);
    owner = false;
    await expect(actions.showVersionsAction(empty, form({ id }))).rejects.toThrow("redirect /login");
    await expect(actions.chooseVersionAction(empty, form({ id, position: 1, listAt: v.at }))).rejects.toThrow("redirect /login");
    expect(get(id)).toMatchObject({ variation: null, versionState: null });
    expect(catalog.calls).toHaveLength(1);
  });

  it("Show versions goes through the catalog once and is allowed once per 10 seconds", async () => {
    const id = insert();
    await show(id);
    expect(catalog.calls).toEqual(["search:1990 Topps 414 Thomas"]);
    expect(await actions.showVersionsAction(empty, form({ id }))).toEqual({ message: versions.SHOW_WAIT });
    expect(catalog.calls).toHaveLength(1);
  });

  it("refuse bad input: position 9 of a 5 row list, a wrong list time, a bad id, a huge name", async () => {
    const id = insert();
    const v = await show(id);
    expect(v.options).toHaveLength(5);
    const before = get(id);
    for (const f of [
      { id, position: 9, listAt: v.at },
      { id, position: 99, listAt: v.at },
      { id, position: "1.5", listAt: v.at },
      { id, position: 1, listAt: v.at + 1 },
      { id, position: 1, listAt: "soon" },
      { id, position: 1 },
    ] as Record<string, string | number>[]) expect((await actions.chooseVersionAction(empty, form(f))).message, JSON.stringify(f)).toBe(versions.LIST_CHANGED);
    expect((await actions.chooseVersionAction(empty, form({ id: "abc", position: 1, listAt: v.at }))).message).toBe(versions.GONE);
    const another = v.options.findIndex((o) => o.kind === "another");
    expect((await actions.chooseVersionAction(empty, form({ id, position: another, listAt: v.at, text: "x".repeat(300) }))).message).toMatch(/under 120/);
    expect((await actions.chooseVersionAction(empty, form({ id, position: another, listAt: v.at, text: "x" }))).message).toBe(versions.ANOTHER_NEEDS);
    expect(get(id)).toEqual(before);
    expect(audits().filter((a) => a.event === "version_chosen")).toHaveLength(0);
  });

  it("the choice writes the version and one audit row with id, state and source, never the typed name", async () => {
    const id = insert();
    let v = await show(id);
    const another = v.options.findIndex((o) => o.kind === "another");
    expect(await actions.chooseVersionAction(empty, form({ id, position: another, listAt: v.at, text: "Secret Blue Foil" }))).toEqual({ message: null });
    expect(get(id)).toMatchObject({ variation: "Secret Blue Foil", versionState: "confirmed", versionSource: "owner" });
    versions.resetShowVersionsLimitForTests();
    v = await show(id);
    await actions.chooseVersionAction(empty, form({ id, position: v.options.length - 1, listAt: v.at }));
    const rows = audits().filter((a) => a.event === "version_chosen");
    expect(rows.map((a) => a.detail)).toEqual([`item ${id}, confirmed, owner`, `item ${id}, not sure`]);
    expect(rows.every((a) => a.outcome === "ok" && !/Secret/.test(a.detail ?? ""))).toBe(true);
  });
});

describe("a version picked in Review", () => {
  function reviewItem() {
    const id = insert({ status: "needs_review" });
    db.update(items).set({ catalogCandidates: serializeCatalog({ status: "candidates", items: THOMAS }, new Date()) }).where(eq(items.id, id)).run();
    return id;
  }
  it("a Tiffany row sets the state confirmed from the catalog; a base row leaves it null", () => {
    const a = reviewItem();
    const stored = THOMAS;
    const tiffany = stored.findIndex((c) => c.sourceId === "551963");
    expect(pick.pickCandidate(a, tiffany, "551963", db).ok).toBe(true);
    expect(get(a)).toMatchObject({ versionState: "confirmed", versionSource: "catalog", variation: "Tiffany" });
    const b = reviewItem();
    const base = stored.findIndex((c) => c.sourceId === "551111");
    expect(pick.pickCandidate(b, base, "551111", db).ok).toBe(true);
    expect(get(b)).toMatchObject({ versionState: null, versionSource: null, variation: null });
  });

  it("Review says there is more than one version when the candidates hold base and Tiffany", () => {
    const id = reviewItem();
    expect(pick.reviewCatalogView(get(id), db)?.severalVersions).toBe(true);
  });
});

describe("no path decides a version for the owner", () => {
  it("Look up again and Show versions leave the version unanswered", async () => {
    const id = insert({ catalogCandidates: null });
    await lookUpAgain(id, { db, catalog: new FakeCatalog({ searches: SEARCHES }) });
    await versions.loadVersionOptions(id, { db, catalog: new FakeCatalog({ searches: SEARCHES }) });
    expect(get(id)).toMatchObject({ versionState: null, versionSource: null, variation: null, isParallel: false, catalogCardId: null });
  });

  it("only the choose path and the owner's pick in Review write the version state", () => {
    const root = path.join(process.cwd(), "src");
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(p, "utf8");
          // An object key (a set() or values() of a write) or an assignment.
          if (/\bversion(State|Source)\s*[:=](?!=)/.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""))) writers.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(writers.sort()).toEqual(["db/schema.ts", "lib/catalog/pick.ts", "lib/catalog/versions.ts"]);
  });
});
