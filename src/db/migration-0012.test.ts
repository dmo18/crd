import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { cardSets, checklistEntries, wantedCards } from "@/db/schema";
import { collectionTotals } from "@/lib/valuation/snapshots";
import { listItems, inventoryFilterSchema } from "@/lib/items/query";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Journal = { entries: { idx: number; tag: string }[] };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
const sql0012 = () => fs.readFileSync(path.join(MIGRATIONS, `${journal().entries.find((e) => e.idx === 12)!.tag}.sql`), "utf8");

/** A copy of the migrations folder that stops at 0011, as on the live site before set progress. */
function migrationsUpTo0011(): string {
  const out = path.join(dir, "drizzle-0011");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const j = journal();
  j.entries = j.entries.filter((e) => e.idx <= 11);
  expect(j.entries).toHaveLength(12);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

const TABLES_WITH_ROWS = ["locations", "scans", "items", "images", "bulk_ops", "valuations", "outside_cache"];

function oldDatabase(file: string): Record<string, Record<string, unknown>[]> {
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  migrate(drizzle(old), { migrationsFolder: migrationsUpTo0011() });
  const tables = (old.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name);
  expect(tables).not.toContain("card_sets");
  old.prepare("insert into locations (name) values (?)").run("Box 1");
  old.prepare("insert into scans (mode, status) values (?, ?)").run("single", "done");
  old.prepare("insert into items (kind, status, scan_id, title, player, year, brand, card_number, quantity, est_value_cents, location_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("card", "needs_review", 1, "Card", "Ken Griffey Jr.", 1990, "Topps", "336", 2, 1500, 1);
  old.prepare("insert into items (kind, status, title, manual_value_cents, sold_price_cents) values (?, ?, ?, ?, ?)").run("sealed", "confirmed", "Box", 9000, null);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, width, height, bytes) values (?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "front", "a.avif", "a-t.avif", 9, 12, 5);
  old.prepare("insert into bulk_ops (at, action, summary, item_count, undo) values (?, ?, ?, ?, ?)").run(3000, "status", "Marked 1 item as checked", 1, "{\"v\":1,\"items\":[]}");
  old.prepare("insert into outside_cache (key, source, kind, body, fetched_at, expires_at, bytes) values (?, ?, ?, ?, ?, ?, ?)").run("k", "mycardfolio", "checklist", "{}", 1, 2, 2);
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES_WITH_ROWS) before[t] = old.prepare(`select * from ${t} order by rowid`).all() as Record<string, unknown>[];
  old.close();
  return before;
}

const rawOf = (db: unknown) => (db as { $client: Database.Database }).$client;

describe("migration 0012", () => {
  it("only creates three new tables and their indexes", () => {
    const statements = sql0012().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.map((s) => s.split("(")[0].trim())).toEqual([
      "CREATE TABLE `card_sets`",
      "CREATE UNIQUE INDEX `card_sets_key_unique` ON `card_sets`",
      "CREATE TABLE `checklist_entries`",
      "CREATE INDEX `checklist_entries_set_idx` ON `checklist_entries`",
      "CREATE TABLE `wanted_cards`",
      "CREATE UNIQUE INDEX `wanted_cards_set_number_uq` ON `wanted_cards`",
    ]);
    expect(sql0012()).not.toMatch(/^\s*(ALTER|DROP|INSERT|UPDATE|DELETE)\b/im);
    expect(journal().entries.map((e) => e.idx).slice(0, 13)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("applies to a 0011 database with rows in it and leaves every old row as it was", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig12-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);
    const db = createDb(file);
    const raw = rawOf(db);
    for (const t of TABLES_WITH_ROWS) expect(raw.prepare(`select * from ${t} order by rowid`).all(), t).toEqual(before[t]);
    expect(raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(collectionTotals(db)).toEqual({ totalValueCents: 12000, itemCount: 2, unitCount: 3 });
    expect(listItems(inventoryFilterSchema.parse({}), db).total).toBe(2);
    // The new tables work, and a set's rows go with it.
    const set = db.insert(cardSets).values({ key: "1990_topps__baseball", year: 1990, brand: "Topps", sport: "baseball" }).returning().get();
    db.insert(checklistEntries).values({ setId: set.id, position: 0, cardNumber: "1", numberKey: "1", player: "Nolan Ryan" }).run();
    db.insert(wantedCards).values({ setId: set.id, numberKey: "1" }).run();
    expect(() => db.insert(wantedCards).values({ setId: set.id, numberKey: "1" }).run()).toThrow();
    expect(() => db.insert(cardSets).values({ key: "1990_topps__baseball", year: 1990 }).run()).toThrow();
    raw.prepare("delete from card_sets").run();
    expect(db.select().from(checklistEntries).all()).toEqual([]);
    expect(db.select().from(wantedCards).all()).toEqual([]);
    raw.close();
  });

  it("the build from before this task still starts on the migrated copy and saves items", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig12-"));
    const file = path.join(dir, "crd.db");
    oldDatabase(file);
    rawOf(createDb(file)).close();
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo0011() });
    expect(old.prepare("insert into items (kind, status, title, quantity) values (?, ?, ?, ?)").run("card", "confirmed", "New", 1).changes).toBe(1);
    expect(old.prepare("update items set status = ?, updated_at = ? where id = ?").run("sold", 5, 1).changes).toBe(1);
    expect(old.prepare("select id from items order by id").all()).toHaveLength(3);
    old.close();
    const again = rawOf(createDb(file));
    expect(again.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });
    again.close();
  });
});
