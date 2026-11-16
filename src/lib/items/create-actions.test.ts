import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, items } from "@/db/schema";
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

const { createItemAction } = await import("./actions");
const { unlinkCatalogAction } = await import("@/lib/catalog/item-actions");

let db: Db;
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const idle = { status: "idle", errors: {} } as const;
const toOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { if (e instanceof Redirected) return e.to; throw e; } };

beforeEach(() => { db = createDb(":memory:"); setDbForTests(db); resetAuditPrune(); owner = true; });
afterEach(() => setDbForTests(undefined));

describe("add by hand action", () => {
  it("is refused without a session", async () => {
    owner = false;
    await expect(createItemAction(idle, form({ kind: "card", player: "x" }))).rejects.toThrow(/login/);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
  it("refuses an empty record with a plain message", async () => {
    const r = await createItemAction(idle, form({ kind: "card" }));
    expect(r.status).toBe("error");
    expect(r.errors.form).toMatch(/at least a player/);
  });
  it("saves a record with only a player and opens it", async () => {
    const to = await toOf(createItemAction(idle, form({ kind: "card", player: "Ken Griffey Jr." })));
    expect(to).toMatch(/^\/items\/\d+$/);
    expect(db.select().from(items).all()).toHaveLength(1);
  });
});

describe("unlink action", () => {
  it("is refused without a session", async () => {
    owner = false;
    await expect(unlinkCatalogAction(form({ id: "1" }))).rejects.toThrow(/login/);
  });
  it("unlinks, keeps fields and writes an audit row", async () => {
    const id = db.insert(items).values({ kind: "card", title: "T", player: "P" }).returning({ id: items.id }).get().id;
    const to = await toOf(unlinkCatalogAction(form({ id: String(id) })));
    expect(to).toBe(`/items/${id}`);
    expect(db.select().from(items).where(eq(items.id, id)).get()?.player).toBe("P");
    expect(db.select().from(auditEvents).where(eq(auditEvents.event, "catalog_card_unlinked")).all()).toHaveLength(1);
  });
  it("refuses a bad id", async () => {
    expect(await toOf(unlinkCatalogAction(form({ id: "abc" })))).toBe("/items");
  });
});
