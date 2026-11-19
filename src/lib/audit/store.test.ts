import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { AUDIT_EVENTS, auditEvents } from "@/db/schema";
import { describeAudit } from "./labels";
import { AUDIT_PAGE_SIZE, KEEP_AUDIT_MS, listAudit, recordAudit, resetAuditPrune } from "./store";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  resetAuditPrune();
});

describe("audit store", () => {
  it("keeps detail short and on one line", () => {
    recordAudit({ event: "item_deleted", outcome: "ok", ip: "unknown", detail: `line one\nline two ${"x".repeat(300)}` }, { db });
    const row = db.select().from(auditEvents).get()!;
    expect(row.detail).not.toContain("\n");
    expect(row.detail!.length).toBeLessThanOrEqual(200);
  });

  it("removes rows older than a year, at most once a day", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    db.insert(auditEvents).values({ at: new Date(now.getTime() - KEEP_AUDIT_MS - 1000), event: "sign_in_ok", outcome: "ok", ip: "a" }).run();
    recordAudit({ event: "sign_in_ok", outcome: "ok", ip: "b" }, { db, now });
    expect(db.select().from(auditEvents).all().map((r) => r.ip)).toEqual(["b"]);
    db.insert(auditEvents).values({ at: new Date(0), event: "sign_in_ok", outcome: "ok", ip: "c" }).run();
    recordAudit({ event: "sign_in_ok", outcome: "ok", ip: "d" }, { db, now: new Date(now.getTime() + 60_000) });
    expect(db.select().from(auditEvents).all()).toHaveLength(3);
  });

  it("can skip repeats from the same address", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const entry = { event: "sign_in_blocked", outcome: "blocked", ip: "1.2.3.4" } as const;
    expect(recordAudit(entry, { db, now, onceWithinMs: 300_000 })).toBe(true);
    expect(recordAudit(entry, { db, now: new Date(now.getTime() + 1000), onceWithinMs: 300_000 })).toBe(false);
    expect(recordAudit({ ...entry, ip: "5.6.7.8" }, { db, now, onceWithinMs: 300_000 })).toBe(true);
  });

  it("lists newest first, 50 per page, security only or everything", () => {
    const t = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 60; i++) db.insert(auditEvents).values({ at: new Date(t + i * 1000), event: "sign_in_failed", outcome: "failed", ip: `10.0.0.${i}` }).run();
    db.insert(auditEvents).values({ at: new Date(t + 999_000), event: "export_csv", outcome: "ok", ip: "x" }).run();
    const first = listAudit("security", 1, db);
    expect(first).toMatchObject({ total: 60, page: 1, pages: 2 });
    expect(first.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.rows[0]!.ip).toBe("10.0.0.59");
    expect(listAudit("security", 2, db).rows).toHaveLength(10);
    expect(listAudit("security", 99, db).page).toBe(2);
    expect(listAudit("all", 1, db).rows[0]!.event).toBe("export_csv");
  });
});

describe("plain-language labels", () => {
  it("has plain words for every event, with and without detail", () => {
    for (const event of AUDIT_EVENTS) {
      for (const detail of [null, "MyCardfolio"]) {
        const line = describeAudit({ event, ip: "unknown", detail });
        expect(line, event).toMatch(/^[A-Z][a-z]/);
        expect(line, event).not.toContain(event);
        expect(line, event).not.toMatch(/undefined|[\u2013\u2014]/);
      }
    }
  });

  it("reads like a sentence", () => {
    expect(describeAudit({ event: "sign_in_failed", ip: "203.0.113.7", detail: null })).toBe("Wrong password from 203.0.113.7");
    expect(describeAudit({ event: "connection_tested", ip: "unknown", detail: "MyCardfolio, works" })).toBe("Tested a connection: MyCardfolio, works");
    expect(describeAudit({ event: "catalog_card_linked", ip: "unknown", detail: null })).toBe("Linked an item to a catalog card");
    expect(describeAudit({ event: "sign_in_ok", ip: "unknown", detail: "new device" })).toBe("Signed in on a new device from an unknown address");
    expect(describeAudit({ event: "location_deleted", ip: "x", detail: "Box 1" })).toBe("Deleted location Box 1");
  });
});
