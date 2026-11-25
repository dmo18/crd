import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, bulkOps, items, type NewItem } from "@/db/schema";
import { resetAuditPrune } from "@/lib/audit/store";

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

const { confirmReviewItemsAction } = await import("./review-actions");
const { undoBulkAction } = await import("./bulk-actions");
const { DuplicateNotice } = await import("@/components/items/DuplicateNotice");

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  owner = true;
});
afterEach(() => setDbForTests(undefined));

const add = (over: Partial<NewItem> = {}) =>
  db.insert(items).values({ kind: "card", title: "1989 Upper Deck #1 Ken Griffey Jr.", status: "needs_review", year: 1989, brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", ...over })
    .returning({ id: items.id }).get().id;
const status = (id: number) => db.select({ s: items.status }).from(items).where(eq(items.id, id)).get()!.s;

describe("confirmReviewItemsAction", () => {
  it("needs the owner session and changes nothing without it", async () => {
    const a = add();
    owner = false;
    await expect(confirmReviewItemsAction([a])).rejects.toThrow(/login/);
    expect(status(a)).toBe("needs_review");
  });

  it("checks its input", async () => {
    for (const bad of [[], "1", [0], [-1], [1.5], ["1"], null, Array.from({ length: 501 }, (_, i) => i + 1)]) {
      expect(await confirmReviewItemsAction(bad)).toMatchObject({ error: expect.any(String) });
    }
    expect(db.select().from(bulkOps).all()).toHaveLength(0);
  });

  it("confirms the chosen ones, logs it, and the Undo button takes it back", async () => {
    const a = add();
    const b = add({ player: "Bo Jackson", cardNumber: "8" });
    const c = add({ player: "Other", cardNumber: "9" });
    const r = await confirmReviewItemsAction([a, b]);
    expect(r).toMatchObject({ changed: 2, summary: "Confirmed 2 items from Review" });
    expect([status(a), status(b), status(c)]).toEqual(["confirmed", "confirmed", "needs_review"]);
    expect(db.select().from(auditEvents).all().map((e) => [e.event, e.detail])).toContainEqual(["bulk_edit", "Confirmed 2 items from Review"]);
    if ("error" in r) throw new Error(r.error);
    expect(await undoBulkAction(r.opId)).toMatchObject({ restored: 2 });
    expect([status(a), status(b)]).toEqual(["needs_review", "needs_review"]);
  });
});

describe("DuplicateNotice for two copies both in Review", () => {
  it("asks plainly, offers no combining", () => {
    const a = add();
    const b = add();
    const html = renderToStaticMarkup(createElement(DuplicateNotice, { itemId: b, title: "Griffey", quantity: 1, db }));
    expect(html).toContain("another one still waiting in Review");
    expect(html).toContain("Keep both as they are");
    expect(html).toContain("Open the other one");
    expect(html).not.toMatch(/Count it with|double entry/);
    expect(html).not.toMatch(/[\u2013\u2014]/);
    expect(a).toBeLessThan(b);
  });
});
