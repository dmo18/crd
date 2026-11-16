import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { auditEvents, images, items, type NewItem } from "@/db/schema";
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

const { keepApartAction, mergeDuplicateAction } = await import("./review-actions");
const { DuplicateNotice } = await import("@/components/items/DuplicateNotice");

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
  resetAuditPrune();
  owner = true;
});
afterEach(() => setDbForTests(undefined));

const card: Partial<NewItem> = { year: 1989, brand: "Upper Deck", setName: "Base", cardNumber: "1", player: "Ken Griffey Jr." };
const add = (over: Partial<NewItem> = {}) =>
  db.insert(items).values({ kind: "card", title: "Griffey", status: "confirmed", ...card, ...over }).returning({ id: items.id }).get().id;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get();
const form = (fields: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
};

describe("duplicate actions", () => {
  it("refuse without a session and change nothing", async () => {
    const old = add();
    const fresh = add({ status: "needs_review" });
    owner = false;
    await expect(mergeDuplicateAction(form({ sourceId: fresh, targetId: old }))).rejects.toThrow(/login/);
    await expect(keepApartAction(form({ itemId: fresh, otherId: old }))).rejects.toThrow(/login/);
    expect(get(fresh)).toBeDefined();
    expect(get(old)).toMatchObject({ quantity: 1, keptApartFrom: null });
  });

  it("refuse bad ids from a hand made form", async () => {
    const old = add();
    for (const bad of ["x", "-1", "1.5", "99999999999"]) {
      await mergeDuplicateAction(form({ sourceId: bad, targetId: old }));
      await keepApartAction(form({ itemId: bad, otherId: old }));
    }
    expect(get(old)).toMatchObject({ quantity: 1, keptApartFrom: null });
  });

  it("merge moves the photos, logs the merge and opens the kept record", async () => {
    const old = add({ quantity: 2 });
    const fresh = add({ status: "needs_review" });
    db.insert(images).values({ itemId: fresh, role: "front", file: "f.jpg", thumbFile: "f-t.jpg", width: 1, height: 1, bytes: 1 }).run();
    await expect(mergeDuplicateAction(form({ sourceId: fresh, targetId: old }))).rejects.toThrow(`redirect /items/${old}`);
    expect(get(fresh)).toBeUndefined();
    expect(get(old)?.quantity).toBe(3);
    expect(db.select().from(images).all()).toMatchObject([{ itemId: old, file: "f.jpg" }]);
    expect(db.select().from(auditEvents).all()).toMatchObject([{ event: "items_merged", outcome: "ok" }]);
  });

  it("a maybe pair is refused by the action too", async () => {
    const old = add({ versionState: "confirmed", versionSource: "owner" });
    const open = add({ status: "needs_review", versionState: "not_sure", versionSource: "owner" });
    await expect(mergeDuplicateAction(form({ sourceId: open, targetId: old }))).rejects.toThrow("redirect /review?merge=maybe");
    expect(get(open)).toBeDefined();
    expect(get(old)?.quantity).toBe(1);
  });

  it("keep apart writes both sides and logs it", async () => {
    const old = add();
    const fresh = add({ status: "needs_review" });
    await keepApartAction(form({ itemId: fresh, otherId: old }));
    expect(get(old)?.keptApartFrom).toBe(JSON.stringify([fresh]));
    expect(get(fresh)?.keptApartFrom).toBe(JSON.stringify([old]));
    expect(db.select().from(auditEvents).all()).toMatchObject([{ event: "duplicate_kept_apart", outcome: "ok" }]);
  });
});

describe("the duplicate notice", () => {
  const html = (id: number) => renderToStaticMarkup(createElement(DuplicateNotice, { itemId: id, title: "Griffey", quantity: 1, db }));

  it("same: three answers, the photo line, no dashes", () => {
    add({ quantity: 2 });
    const out = html(add({ status: "needs_review" }));
    expect(out).toContain("You already have this card");
    expect(out).toContain("Count it with the old one");
    expect(out).toContain("Keep both as they are");
    expect(out).toContain("Open the old one to fix it");
    expect(out).toContain("quantity of 3");
    expect(out).toContain("The photos of this record move to the old one");
    expect(out).not.toMatch(/[–—]/);
  });

  it("maybe: no combine button", () => {
    add({ versionState: "confirmed", versionSource: "owner" });
    const out = html(add({ status: "needs_review", versionState: "not_sure", versionSource: "owner" }));
    expect(out).toContain("This may be a card you already have");
    expect(out).not.toContain("Count it with the old one");
    expect(out).not.toContain("mergeDuplicate");
    expect(out).toContain("Keep both as they are");
    expect(out).toContain("Open the old one to fix it");
  });

  it("same numbered: remove the double entry, quantity stays", () => {
    add({ serialCopy: "045", serialEdition: "100", serialNumber: "045/100" });
    const out = html(add({ status: "needs_review", serialCopy: "045", serialEdition: "100", serialNumber: "045/100" }));
    expect(out).toContain("very same numbered card (045/100) entered twice");
    expect(out).toContain("Remove this double entry");
    expect(out).toContain("keeps its quantity of 1");
  });

  it("nothing when the pair was kept apart", () => {
    const old = add();
    const fresh = add({ status: "needs_review", keptApartFrom: "[1]" });
    expect(old).toBe(1);
    expect(html(fresh)).toBe("");
  });
});
