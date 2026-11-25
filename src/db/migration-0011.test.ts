import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { items } from "@/db/schema";
import { collectionTotals } from "@/lib/valuation/snapshots";
import { listItems, inventoryFilterSchema } from "@/lib/items/query";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Journal = { entries: { idx: number; tag: string }[] };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
const sql0011 = () => fs.readFileSync(path.join(MIGRATIONS, `${journal().entries.find((e) => e.idx === 11)!.tag}.sql`), "utf8");

/** A copy of the migrations folder that stops at 0010, as on the live site before Sold and removed. */
function migrationsUpTo0010(): string {
  const out = path.join(dir, "drizzle-0010");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const j = journal();
  j.entries = j.entries.filter((e) => e.idx <= 10);
  expect(j.entries).toHaveLength(11);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

const TABLES_WITH_ROWS = ["locations", "scans", "items", "images", "bulk_ops", "valuations"];

function oldDatabase(file: string): Record<string, Record<string, unknown>[]> {
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  migrate(drizzle(old), { migrationsFolder: migrationsUpTo0010() });
  const cols = (old.prepare("pragma table_info(items)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain("sold_price_cents");
  old.prepare("insert into locations (name) values (?)").run("Box 1");
  old.prepare("insert into scans (mode, status) values (?, ?)").run("single", "done");
  old.prepare("insert into items (kind, status, scan_id, title, player, quantity, est_value_cents, location_id) values (?, ?, ?, ?, ?, ?, ?, ?)").run("card", "needs_review", 1, "Card", "Ken Griffey Jr.", 2, 1500, 1);
  old.prepare("insert into items (kind, status, title, manual_value_cents) values (?, ?, ?, ?)").run("sealed", "confirmed", "Box", 9000);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, width, height, bytes) values (?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "front", "a.avif", "a-t.avif", 9, 12, 5);
  old.prepare("insert into bulk_ops (at, action, summary, item_count, undo) values (?, ?, ?, ?, ?)").run(3000, "status", "Marked 1 item as checked", 1, "{\"v\":1,\"items\":[]}");
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES_WITH_ROWS) before[t] = old.prepare(`select * from ${t} order by rowid`).all() as Record<string, unknown>[];
  old.close();
  return before;
}

const rawOf = (db: unknown) => (db as { $client: Database.Database }).$client;
const NEW = { sold_price_cents: null, sold_at: null, status_before: null };

describe("migration 0011", () => {
  it("only adds three nullable columns to items", () => {
    const statements = sql0011().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([
      "ALTER TABLE `items` ADD `sold_price_cents` integer;",
      "ALTER TABLE `items` ADD `sold_at` integer;",
      "ALTER TABLE `items` ADD `status_before` text;",
    ]);
    expect(journal().entries.map((e) => e.idx).slice(0, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("applies to a 0010 database with rows in it and leaves every old row as it was", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig11-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);
    const db = createDb(file);
    const raw = rawOf(db);
    for (const t of TABLES_WITH_ROWS) {
      const after = raw.prepare(`select * from ${t} order by rowid`).all();
      expect(after, t).toEqual(before[t].map((r) => (t === "items" ? { ...r, ...NEW } : r)));
    }
    expect(raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    // Old items are still in the collection, with the same totals and lists.
    expect(collectionTotals(db)).toEqual({ totalValueCents: 12000, itemCount: 2, unitCount: 3 });
    expect(listItems(inventoryFilterSchema.parse({}), db).total).toBe(2);
    expect(db.select().from(items).all().map((i) => [i.status, i.soldPriceCents, i.soldAt, i.statusBefore])).toEqual([
      ["needs_review", null, null, null], ["confirmed", null, null, null],
    ]);
    raw.close();
  });

  it("the build from before this task still starts on the migrated copy and saves items", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig11-"));
    const file = path.join(dir, "crd.db");
    oldDatabase(file);
    rawOf(createDb(file)).close();
    // The previous build runs its own migrations folder (stops at 0010) and its own queries.
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo0010() });
    expect(old.prepare("insert into items (kind, status, title, quantity) values (?, ?, ?, ?)").run("card", "confirmed", "New", 1).changes).toBe(1);
    expect(old.prepare("update items set status = ?, updated_at = ? where id = ?").run("confirmed", 5, 1).changes).toBe(1);
    expect(old.prepare("select id, title, status, quantity, est_value_cents, deleted_at from items order by id").all()).toHaveLength(3);
    expect(old.prepare("select sold_price_cents from items where title = ?").get("New")).toEqual({ sold_price_cents: null });
    old.close();
    const again = rawOf(createDb(file));
    expect(again.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });
    again.close();
  });
});
