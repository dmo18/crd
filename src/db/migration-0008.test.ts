import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { bulkOps, catalogCards, images, items, scans, valuations } from "@/db/schema";
import { itemsToCsv } from "@/lib/export/csv";
import { latestUndoable, undoBulk } from "@/lib/items/bulk";
import { listItems, inventoryFilterSchema } from "@/lib/items/query";
import { confirmItem, updateItem } from "@/lib/items/update";
import { applyCatalogCard } from "@/lib/catalog/apply";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const NEW_TABLES = ["catalog_cards", "catalog_sources", "connection_keys", "outside_cache", "outside_state", "outside_usage"];
const NEW_ITEM_COLUMNS = ["catalog_card_id", "first_suggestion", "field_sources", "catalog_candidates"];
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Journal = { entries: { idx: number; tag: string }[] };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
const sql0008 = () => fs.readFileSync(path.join(MIGRATIONS, `${journal().entries.find((e) => e.idx === 8)!.tag}.sql`), "utf8");

/** A copy of the migrations folder that stops at 0007, as on the live site before Milestone 10. */
function migrationsUpTo0007(): string {
  const out = path.join(dir, "drizzle");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const j = journal();
  j.entries = j.entries.filter((e) => e.idx <= 7);
  expect(j.entries).toHaveLength(8);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

const TABLES_WITH_ROWS = ["locations", "scans", "items", "images", "valuations", "bulk_ops", "audit_events", "collection_snapshots", "player_facts"];

/** A database as the live one is today: migrations 0000 to 0007 and rows in it. */
function oldDatabase(file: string): Record<string, unknown[]> {
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  migrate(drizzle(old), { migrationsFolder: migrationsUpTo0007() });
  const cols = (old.prepare("pragma table_info(items)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("deleted_at");
  for (const c of NEW_ITEM_COLUMNS) expect(cols).not.toContain(c);

  old.prepare("insert into locations (name) values (?)").run("Box 1");
  old.prepare("insert into scans (mode, status, client_key, recognizer, item_count) values (?, ?, ?, ?, ?)").run("single", "done", "k1", "free", 1);
  old.prepare("insert into scans (mode, status) values (?, ?)").run("multi", "failed");
  const add = old.prepare(
    "insert into items (kind, status, scan_id, title, sport, year, brand, card_number, player, team, quantity, location_id, confidence, est_low_cents, est_high_cents, est_value_cents, manual_value_cents, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  add.run("card", "confirmed", 1, "1989 Upper Deck #1 Ken Griffey Jr.", "baseball", 1989, "Upper Deck", "1", "Ken Griffey Jr.", "Mariners", 2, 1, 0.93, 4000, 8000, 6000, 1500, 1000, 2000, null);
  add.run("sealed", "needs_review", null, "1990 Topps wax box", null, 1990, "Topps", null, null, null, 1, null, null, null, null, null, null, 1000, 1000, null);
  add.run("card", "needs_review", 1, "Twins card", null, null, null, null, null, "Twins", 1, null, 0.4, null, null, null, null, 1000, 1000, null);
  add.run("bulk", "confirmed", null, "Bulk lot", null, null, null, null, null, null, 1, null, null, null, null, null, null, 1000, 1000, 5000);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, work_file, width, height, bytes, thumb_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, 1, "front", "a.avif", "a-thumb.avif", null, 900, 1200, 1000, 90);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, work_file, width, height, bytes, thumb_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(null, 2, "source", "b.avif", "b-thumb.avif", "b.jpg", 900, 1200, 2000, 80);
  old.prepare("insert into valuations (item_id, source, low_cents, high_cents, value_cents) values (?, ?, ?, ?, ?)").run(1, "ai_estimate", 4000, 8000, 6000);
  old.prepare("insert into valuations (item_id, source, value_cents) values (?, ?, ?)").run(1, "manual", 1500);
  old.prepare("insert into bulk_ops (at, action, summary, item_count, undo) values (?, ?, ?, ?, ?)")
    .run(3000, "set", "Set team on 1 item", 1, JSON.stringify({ v: 1, items: [[3, { team: "Twns", updatedAt: 500 }]] }));
  old.prepare("insert into audit_events (event, ip, outcome, detail) values (?, ?, ?, ?)").run("bulk_edit", "unknown", "ok", "Set team on 1 item");
  old.prepare("insert into collection_snapshots (day, total_value_cents, item_count, unit_count) values (?, ?, ?, ?)").run("2026-11-15", 3000, 3, 4);
  old.prepare("insert into player_facts (key, facts, fetched_at) values (?, ?, ?)").run("ken griffey jr|baseball", "[]", 1000);

  const before: Record<string, unknown[]> = {};
  for (const t of TABLES_WITH_ROWS) {
    before[t] = old.prepare(`select * from ${t} order by rowid`).all();
    expect(before[t].length, t).toBeGreaterThan(0);
  }
  old.close();
  return before;
}

describe("migration 0008", () => {
  it("only adds: new tables, new indexes and nullable item columns", () => {
    const statements = sql0008().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    const created: string[] = [];
    const added: string[] = [];
    for (const s of statements) {
      const table = /^CREATE TABLE `(\w+)` \(/.exec(s);
      const idx = /^CREATE (?:UNIQUE )?INDEX `\w+` ON `(\w+)` \(/.exec(s);
      const col = /^ALTER TABLE `items` ADD `(\w+)` (?:text|integer)( REFERENCES `catalog_cards`\(`id`\) ON UPDATE no action ON DELETE set null)?;$/.exec(s);
      expect(Boolean(table || idx || col), s).toBe(true);
      if (table) created.push(table[1]);
      if (col) added.push(col[1]);
      // An index is only made on a new table or on the new item column.
      if (idx) expect(idx[1] === "items" ? s.includes("(`catalog_card_id`)") : NEW_TABLES.includes(idx[1]), s).toBe(true);
    }
    expect(created.sort()).toEqual(NEW_TABLES);
    expect(added).toEqual(NEW_ITEM_COLUMNS);
    expect(sql0008()).not.toMatch(/\b(DROP|RENAME|DELETE FROM|UPDATE `|INSERT INTO|PRAGMA|__new_)/i);
    expect(journal().entries.map((e) => e.idx).slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("applies to a 0007 database with rows in it and leaves every old row as it was", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);

    // The app's normal start: opens the file and applies what is missing (0008).
    const db = createDb(file);
    const raw = (db as unknown as { $client: Database.Database }).$client;
    const nulls = Object.fromEntries(NEW_ITEM_COLUMNS.map((c) => [c, null]));
    // Columns of later migrations (0009 on) are new and empty too.
    const laterNulls = (t: string, row: object) => {
      const known = new Set([...Object.keys(before[t][0] as object), ...(t === "items" ? NEW_ITEM_COLUMNS : [])]);
      return Object.fromEntries(Object.keys(row).filter((c) => !known.has(c)).map((c) => [c, null]));
    };
    for (const t of TABLES_WITH_ROWS) {
      const after = raw.prepare(`select * from ${t} order by rowid`).all() as object[];
      const want = before[t].map((r, i) => ({ ...(r as object), ...(t === "items" ? nulls : {}), ...laterNulls(t, after[i] ?? {}) }));
      expect(after, t).toEqual(want);
    }
    for (const t of NEW_TABLES) expect(raw.prepare(`select count(*) as n from ${t}`).get(), t).toEqual({ n: 0 });
    const indexes = (raw.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining([
      "items_catalog_card_idx", "catalog_cards_canonical_key_unique", "catalog_sources_source_id_uq", "catalog_sources_card_idx",
      "outside_cache_expires_idx", "items_deleted_idx", "bulk_ops_at_idx", "scans_client_key_uq",
    ]));
    const fk = (raw.prepare("pragma foreign_key_list(items)").all() as { table: string; from: string; on_delete: string }[]).find((f) => f.table === "catalog_cards");
    expect(fk).toMatchObject({ from: "catalog_card_id", on_delete: "SET NULL" });
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);

    // The app's readers still work on the old rows.
    const list = listItems(inventoryFilterSchema.parse({}), db);
    expect(list.total).toBe(3);
    const all = db.select().from(items).all();
    expect(all).toHaveLength(4);
    for (const row of all) expect(row).toMatchObject({ catalogCardId: null, firstSuggestion: null, fieldSources: null, catalogCandidates: null });
    expect(all[0]).toMatchObject({ title: "1989 Upper Deck #1 Ken Griffey Jr.", manualValueCents: 1500, estValueCents: 6000, quantity: 2, locationId: 1 });
    expect(db.select().from(scans).all()).toHaveLength(2);
    expect(db.select().from(images).all()).toHaveLength(2);
    expect(db.select().from(valuations).all().map((v) => v.valueCents)).toEqual([6000, 1500]);
    expect(itemsToCsv(all, new Map([[1, "Box 1"]])).split("\r\n")).toHaveLength(6);
    expect(latestUndoable(db, new Date(4000))).toMatchObject({ id: 1, summary: "Set team on 1 item" });

    // And its writers: edit, confirm, undo of a bulk change saved before the migration.
    expect(undoBulk(1, db, new Date(4000))).toMatchObject({ restored: 1, skipped: 0 });
    expect(db.select().from(items).where(eq(items.id, 3)).get()).toMatchObject({ team: "Twns", fieldSources: null });
    expect(db.select().from(bulkOps).get()!.undoneAt).toEqual(new Date(4000));
    expect(updateItem(1, { quantity: "2", sport: "baseball", year: "1989", brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners", manualValue: "15.00" }, db)).toEqual({ ok: true });
    expect(db.select().from(items).where(eq(items.id, 1)).get()).toMatchObject({ team: "Seattle Mariners", manualValueCents: 1500, fieldSources: null, firstSuggestion: null });
    expect(confirmItem(2, db)).toEqual({ ok: true });

    // An old item (null sources) meets a catalog card: its words are never overwritten.
    const card = db.insert(catalogCards).values({
      canonicalKey: "v1|baseball|1989|upperdeck|base|1|ken griffey jr", sport: "baseball", year: 1989, brand: "UD", cardNumber: "001", player: "Griffey", team: "M's",
    }).returning().get();
    const one = db.select().from(items).where(eq(items.id, 1)).get()!;
    expect(applyCatalogCard(one, card, { useCatalogValues: true }).patch).toEqual({ catalogCardId: card.id });
    raw.close();
  });

  it("statements of the build before this task still run on the new layout", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);
    const oldColumns = Object.keys(before.items[0] as object);
    const raw = (createDb(file) as unknown as { $client: Database.Database }).$client;

    // The old build names its columns one by one (Drizzle never sends "select *"),
    // so it reads and writes only the columns it knows.
    const list = oldColumns.map((c) => `"${c}"`).join(", ");
    expect(raw.prepare(`select ${list} from items order by id`).all()).toEqual(before.items);
    const insertCols = oldColumns.filter((c) => c !== "id");
    const first = before.items[0] as Record<string, unknown>;
    const res = raw.prepare(`insert into items (${insertCols.map((c) => `"${c}"`).join(", ")}) values (${insertCols.map(() => "?").join(", ")})`)
      .run(...insertCols.map((c) => first[c]));
    expect(res.changes).toBe(1);
    const copy = raw.prepare("select * from items where id = ?").get(res.lastInsertRowid) as Record<string, unknown>;
    expect(copy).toMatchObject({ title: first.title, catalog_card_id: null, first_suggestion: null, field_sources: null, catalog_candidates: null });
    // The shortest insert the old build makes (kind and title only) still works too.
    expect(raw.prepare("insert into items (kind, title) values (?, ?)").run("card", "Plain").changes).toBe(1);
    expect(raw.prepare("update items set team = ?, updated_at = ? where id = ? and deleted_at is null").run("Mariners", 9000, 3).changes).toBe(1);
    expect(raw.prepare("delete from items where id = ?").run(4).changes).toBe(1);
    // Starting again finds nothing left to apply and changes nothing.
    raw.close();
    const again = (createDb(file) as unknown as { $client: Database.Database }).$client;
    expect(again.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });
    expect(again.prepare("select count(*) as n from items").get()).toEqual({ n: 5 });
    again.close();
  });
});
