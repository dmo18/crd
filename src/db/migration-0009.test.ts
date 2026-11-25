import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { bulkOps, catalogCards, catalogSources, images, items, scans } from "@/db/schema";
import { itemsToCsv } from "@/lib/export/csv";
import { applyBulk, latestUndoable, undoBulk } from "@/lib/items/bulk";
import { listItems, inventoryFilterSchema } from "@/lib/items/query";
import { readRookie } from "@/lib/items/rookie";
import { splitSerial } from "@/lib/items/serial";
import { confirmItem, updateItem } from "@/lib/items/update";
import { applyCatalogCard } from "@/lib/catalog/apply";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const NEW_ITEM_COLUMNS = [
  "version_state", "version_source", "version_options", "serial_copy", "serial_edition", "serial_suggested",
  "rookie_state", "rookie_source", "rookie_note", "kept_apart_from",
];
const NEW_IMAGE_COLUMNS = ["original_file"];
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Journal = { entries: { idx: number; tag: string }[] };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
const sql0009 = () => fs.readFileSync(path.join(MIGRATIONS, `${journal().entries.find((e) => e.idx === 9)!.tag}.sql`), "utf8");

/** A copy of the migrations folder that stops at 0008, as on the live site before Milestone 11. */
function migrationsUpTo0008(): string {
  const out = path.join(dir, "drizzle-0008");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const j = journal();
  j.entries = j.entries.filter((e) => e.idx <= 8);
  expect(j.entries).toHaveLength(9);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

const TABLES_WITH_ROWS = [
  "locations", "scans", "items", "images", "valuations", "bulk_ops", "audit_events", "catalog_cards", "catalog_sources",
  "outside_usage", "outside_state", "outside_cache", "collection_snapshots", "player_facts",
];

/** A database as the live one is today: migrations 0000 to 0008 and rows in it. */
function oldDatabase(file: string): Record<string, Record<string, unknown>[]> {
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  migrate(drizzle(old), { migrationsFolder: migrationsUpTo0008() });
  const cols = (t: string) => (old.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  expect(cols("items")).toContain("catalog_candidates");
  for (const c of NEW_ITEM_COLUMNS) expect(cols("items")).not.toContain(c);
  for (const c of NEW_IMAGE_COLUMNS) expect(cols("images")).not.toContain(c);

  old.prepare("insert into locations (name) values (?)").run("Box 1");
  old.prepare("insert into scans (mode, status, client_key, recognizer, item_count) values (?, ?, ?, ?, ?)").run("single", "done", "k1", "free", 1);
  old.prepare("insert into scans (mode, status) values (?, ?)").run("multi", "failed");
  old.prepare("insert into catalog_cards (canonical_key, sport, year, brand, card_number, player, team, verified, field_sources) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("v1|baseball|1989|upperdeck|base|1|ken griffey jr", "baseball", 1989, "Upper Deck", "1", "Ken Griffey Jr.", "Seattle Mariners", 1, "{\"player\":\"catalog\"}");
  old.prepare("insert into catalog_sources (catalog_card_id, source, source_id, url, fetched_at) values (?, ?, ?, ?, ?)")
    .run(1, "mycardfolio", "551033", "https://example.test/card/551033", 1000);
  const add = old.prepare(
    "insert into items (kind, status, scan_id, title, sport, year, brand, card_number, player, team, is_rookie, serial_number, quantity, location_id, confidence, est_low_cents, est_high_cents, est_value_cents, manual_value_cents, catalog_card_id, first_suggestion, field_sources, catalog_candidates, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  add.run("card", "confirmed", 1, "1989 Upper Deck #1 Ken Griffey Jr.", "baseball", 1989, "Upper Deck", "1", "Ken Griffey Jr.", "Mariners", 1, "045/100", 2, 1, 0.93, 4000, 8000, 6000, 1500, 1,
    "{\"v\":1,\"fields\":{\"player\":\"Ken Griffey Jr.\"},\"confidence\":0.93,\"reader\":\"free\",\"at\":1000}", "{\"player\":\"reading\"}", null, 1000, 2000, null);
  add.run("sealed", "needs_review", null, "1990 Topps wax box", null, 1990, "Topps", null, null, null, 0, null, 1, null, null, null, null, null, null, null, null, null, null, 1000, 1000, null);
  add.run("card", "needs_review", 1, "Twins card", null, null, null, null, null, "Twins", 0, "1 of 1 promo", 1, null, 0.4, null, null, null, null, null, null, null,
    "{\"v\":1,\"at\":1000,\"status\":\"none\"}", 1000, 1000, null);
  add.run("bulk", "confirmed", null, "Bulk lot", null, null, null, null, null, null, 0, null, 1, null, null, null, null, null, null, null, null, null, null, 1000, 1000, 5000);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, work_file, width, height, bytes, thumb_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, 1, "front", "a.avif", "a-thumb.avif", null, 900, 1200, 1000, 90);
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, work_file, width, height, bytes, thumb_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(null, 2, "source", "b.avif", "b-thumb.avif", "b.jpg", 900, 1200, 2000, 80);
  old.prepare("insert into valuations (item_id, source, low_cents, high_cents, value_cents) values (?, ?, ?, ?, ?)").run(1, "ai_estimate", 4000, 8000, 6000);
  old.prepare("insert into bulk_ops (at, action, summary, item_count, undo) values (?, ?, ?, ?, ?)")
    .run(3000, "set", "Set team on 1 item", 1, JSON.stringify({ v: 1, items: [[3, { team: "Twns", updatedAt: 500 }]] }));
  old.prepare("insert into audit_events (event, ip, outcome, detail) values (?, ?, ?, ?)").run("catalog_card_linked", "unknown", "ok", "item 1");
  old.prepare("insert into outside_usage (source, day, calls) values (?, ?, ?)").run("mycardfolio", "2026-11-16", 3);
  old.prepare("insert into outside_state (source, enabled) values (?, ?)").run("mycardfolio", 1);
  old.prepare("insert into outside_cache (key, source, kind, body, fetched_at, expires_at, bytes) values (?, ?, ?, ?, ?, ?, ?)").run("k", "mycardfolio", "search", "{}", 1000, 9000, 2);
  old.prepare("insert into collection_snapshots (day, total_value_cents, item_count, unit_count) values (?, ?, ?, ?)").run("2026-11-15", 3000, 3, 4);
  old.prepare("insert into player_facts (key, facts, fetched_at) values (?, ?, ?)").run("ken griffey jr|baseball", "[]", 1000);

  const before: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES_WITH_ROWS) {
    before[t] = old.prepare(`select * from ${t} order by rowid`).all() as Record<string, unknown>[];
    expect(before[t].length, t).toBeGreaterThan(0);
  }
  old.close();
  return before;
}

const rawOf = (db: unknown) => (db as { $client: Database.Database }).$client;

describe("migration 0009", () => {
  it("only adds nullable columns to items and images", () => {
    const statements = sql0009().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    const added: Record<string, string[]> = { items: [], images: [] };
    for (const s of statements) {
      const col = /^ALTER TABLE `(items|images)` ADD `(\w+)` text;$/.exec(s);
      expect(Boolean(col), s).toBe(true);
      added[col![1]].push(col![2]);
    }
    expect(added.items).toEqual(NEW_ITEM_COLUMNS);
    expect(added.images).toEqual(NEW_IMAGE_COLUMNS);
    expect(sql0009()).not.toMatch(/\b(CREATE TABLE|DROP|RENAME|DELETE FROM|UPDATE `|INSERT INTO|PRAGMA|NOT NULL|DEFAULT|__new_)/i);
    expect(journal().entries.map((e) => e.idx).slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("applies to a 0008 database with rows in it and leaves every old row as it was", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig9-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);

    // The app's normal start: opens the file and applies what is missing (0009).
    const db = createDb(file);
    const raw = rawOf(db);
    const newCols: Record<string, string[]> = { items: NEW_ITEM_COLUMNS, images: NEW_IMAGE_COLUMNS };
    // Columns of later migrations (0010 on) are new and empty too.
    const laterNulls = (t: string, row: object) => {
      const known = new Set([...Object.keys(before[t][0]), ...(newCols[t] ?? [])]);
      return Object.fromEntries(Object.keys(row).filter((c) => !known.has(c)).map((c) => [c, null]));
    };
    for (const t of TABLES_WITH_ROWS) {
      const after = raw.prepare(`select * from ${t} order by rowid`).all() as object[];
      const nulls = Object.fromEntries((newCols[t] ?? []).map((c) => [c, null]));
      expect(after, t).toEqual(before[t].map((r, i) => ({ ...r, ...nulls, ...laterNulls(t, after[i] ?? {}) })));
    }
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const tables = (raw.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).length;
    const indexes = (raw.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["items_catalog_card_idx", "catalog_sources_source_id_uq", "images_work_idx", "items_deleted_idx"]));

    // The app's readers still work on the old rows, and read the old values the new way without writing.
    expect(listItems(inventoryFilterSchema.parse({}), db).total).toBe(3);
    expect(listItems(inventoryFilterSchema.parse({ rookie: "1" }), db).total).toBe(1);
    const all = db.select().from(items).all();
    expect(all).toHaveLength(4);
    for (const row of all) {
      expect(row).toMatchObject({ versionState: null, versionSource: null, versionOptions: null, serialCopy: null, serialEdition: null,
        serialSuggested: null, rookieState: null, rookieSource: null, rookieNote: null, keptApartFrom: null });
    }
    expect(all[0]).toMatchObject({ isRookie: true, serialNumber: "045/100", catalogCardId: 1, manualValueCents: 1500, quantity: 2 });
    expect(readRookie(all[0])).toEqual({ state: "yes", source: null, note: null, sourceRecorded: false });
    expect(readRookie(all[2])).toEqual({ state: null, source: null, note: null, sourceRecorded: false });
    expect(splitSerial(all[0].serialNumber)).toEqual({ copy: "045", edition: "100" });
    expect(splitSerial(all[2].serialNumber)).toBeNull();
    expect(db.select().from(images).all().map((i) => i.originalFile)).toEqual([null, null]);
    expect(db.select().from(scans).all()).toHaveLength(2);
    expect(db.select().from(catalogSources).all()).toHaveLength(1);
    // The spreadsheet has the same columns as before: the new ones are left out.
    const csv = itemsToCsv(all, new Map([[1, "Box 1"]])).replace(/^﻿/, "").split("\r\n");
    expect(csv).toHaveLength(6);
    expect(csv[0]).not.toMatch(/version|copy|edition|kept|original/i);
    expect(latestUndoable(db, new Date(4000))).toMatchObject({ id: 1, summary: "Set team on 1 item" });
    const itemsNow = raw.prepare("select * from items order by rowid").all() as object[];
    expect(itemsNow).toEqual(before.items.map((r, i) => ({ ...r, ...Object.fromEntries(NEW_ITEM_COLUMNS.map((c) => [c, null])), ...laterNulls("items", itemsNow[i] ?? {}) })));

    // And its writers: undo of a bulk change saved before the migration, edit, confirm, catalog.
    expect(undoBulk(1, db, new Date(4000))).toMatchObject({ restored: 1, skipped: 0 });
    expect(db.select().from(items).where(eq(items.id, 3)).get()).toMatchObject({ team: "Twns", rookieState: null, serialNumber: "1 of 1 promo" });
    expect(db.select().from(bulkOps).get()!.undoneAt).toEqual(new Date(4000));
    // The owner saves the old Griffey: the serial is written in the new form, the rookie mark is left as it was.
    expect(updateItem(1, { quantity: "2", sport: "baseball", year: "1989", brand: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners", isRookie: true, serialNumber: "045/100", manualValue: "15.00" }, db)).toEqual({ ok: true });
    expect(db.select().from(items).where(eq(items.id, 1)).get()).toMatchObject({
      team: "Seattle Mariners", serialNumber: "045/100", serialCopy: "045", serialEdition: "100", isRookie: true, rookieState: null, catalogCardId: 1,
    });
    // An old text that does not split is kept whole.
    expect(updateItem(3, { quantity: "1", team: "Twins", serialNumber: "1 of 1 promo" }, db)).toEqual({ ok: true });
    expect(db.select().from(items).where(eq(items.id, 3)).get()).toMatchObject({ serialNumber: "1 of 1 promo", serialCopy: null, serialEdition: null });
    expect(confirmItem(2, db)).toEqual({ ok: true });
    const r = applyBulk({ ids: [3] }, { type: "set", field: "isRookie", value: true, onlyEmpty: false }, db, new Date(9000));
    expect(r).toMatchObject({ changed: 1 });
    expect(db.select().from(items).where(eq(items.id, 3)).get()).toMatchObject({ isRookie: true, rookieState: "yes", rookieSource: "owner" });
    const card = db.select().from(catalogCards).get()!;
    const one = db.select().from(items).where(eq(items.id, 1)).get()!;
    expect(applyCatalogCard(one, card, { useCatalogValues: false }).patch).toEqual({});
    expect((raw.prepare("select name from sqlite_master where type = 'table'").all() as unknown[]).length).toBe(tables);
    raw.close();
  });

  it("the build from before this task still starts on the migrated copy, and its statements still run", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig9-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);
    const oldItemColumns = Object.keys(before.items[0]);
    const oldImageColumns = Object.keys(before.images[0]);
    rawOf(createDb(file)).close();

    // The old build starts: its migrator (folder up to 0008) finds nothing to apply.
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo0008() });
    expect(old.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });

    // It names its columns one by one (Drizzle never sends "select *"), so it reads and writes only what it knows.
    const list = (cols: string[]) => cols.map((c) => `"${c}"`).join(", ");
    expect(old.prepare(`select ${list(oldItemColumns)} from items order by id`).all()).toEqual(before.items);
    expect(old.prepare(`select ${list(oldImageColumns)} from images order by id`).all()).toEqual(before.images);
    const insertCols = oldItemColumns.filter((c) => c !== "id");
    const first = before.items[0];
    const res = old.prepare(`insert into items (${list(insertCols)}) values (${insertCols.map(() => "?").join(", ")})`).run(...insertCols.map((c) => first[c]));
    const copy = old.prepare("select * from items where id = ?").get(res.lastInsertRowid) as Record<string, unknown>;
    expect(copy).toMatchObject({ title: first.title, is_rookie: 1, rookie_state: null, serial_copy: null, kept_apart_from: null });
    expect(old.prepare("insert into images (item_id, role, file, thumb_file, width, height, bytes) values (?, ?, ?, ?, ?, ?, ?)").run(1, "back", "c.avif", "c-thumb.avif", 10, 10, 5).changes).toBe(1);
    expect(old.prepare("insert into items (kind, title) values (?, ?)").run("card", "Plain").changes).toBe(1);
    expect(old.prepare("update items set is_rookie = ?, updated_at = ? where id = ? and deleted_at is null").run(0, 9000, 1).changes).toBe(1);
    expect(old.prepare("delete from items where id = ?").run(4).changes).toBe(1);
    old.close();

    // Starting the new build again finds nothing left to apply and changes nothing.
    const again = rawOf(createDb(file));
    expect(again.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });
    expect(again.prepare("select count(*) as n from items").get()).toEqual({ n: 5 });
    expect(again.prepare("select original_file from images where file = ?").get("c.avif")).toEqual({ original_file: null });
    again.close();
  });
});
