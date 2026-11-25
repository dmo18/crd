import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { scans } from "@/db/schema";
import { batchReports } from "@/lib/scans/batch";
import { recentScans } from "@/lib/scans/view";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Journal = { entries: { idx: number; tag: string }[] };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
const sql0010 = () => fs.readFileSync(path.join(MIGRATIONS, `${journal().entries.find((e) => e.idx === 10)!.tag}.sql`), "utf8");

/** A copy of the migrations folder that stops at 0009, as on the live site before batch scanning. */
function migrationsUpTo0009(): string {
  const out = path.join(dir, "drizzle-0009");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const j = journal();
  j.entries = j.entries.filter((e) => e.idx <= 9);
  expect(j.entries).toHaveLength(10);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

const TABLES_WITH_ROWS = ["locations", "scans", "items", "images", "bulk_ops"];

function oldDatabase(file: string): Record<string, Record<string, unknown>[]> {
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  migrate(drizzle(old), { migrationsFolder: migrationsUpTo0009() });
  const cols = (old.prepare("pragma table_info(scans)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("client_key");
  expect(cols).not.toContain("batch_key");
  old.prepare("insert into locations (name) values (?)").run("Box 1");
  old.prepare("insert into scans (mode, status, client_key, recognizer, item_count) values (?, ?, ?, ?, ?)").run("single", "done", "k1", "free", 1);
  old.prepare("insert into scans (mode, status) values (?, ?)").run("single", "queued");
  old.prepare("insert into scans (mode, status, error) values (?, ?, ?)").run("multi", "failed", "Try again.");
  old.prepare("insert into items (kind, status, scan_id, title, player) values (?, ?, ?, ?, ?)").run("card", "needs_review", 1, "Card", "Ken Griffey Jr.");
  old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, width, height, bytes) values (?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "front", "a.avif", "a-t.avif", 9, 12, 5);
  old.prepare("insert into bulk_ops (at, action, summary, item_count, undo) values (?, ?, ?, ?, ?)").run(3000, "status", "Marked 1 item as checked", 1, "{\"v\":1,\"items\":[]}");
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES_WITH_ROWS) before[t] = old.prepare(`select * from ${t} order by rowid`).all() as Record<string, unknown>[];
  old.close();
  return before;
}

const rawOf = (db: unknown) => (db as { $client: Database.Database }).$client;

describe("migration 0010", () => {
  it("only adds one nullable column to scans and an index on it", () => {
    const statements = sql0010().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([
      "ALTER TABLE `scans` ADD `batch_key` text;",
      "CREATE INDEX `scans_batch_key_idx` ON `scans` (`batch_key`);",
    ]);
    expect(journal().entries.map((e) => e.idx).slice(0, 11)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("applies to a 0009 database with rows in it and leaves every old row as it was", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig10-"));
    const file = path.join(dir, "crd.db");
    const before = oldDatabase(file);
    const db = createDb(file);
    const raw = rawOf(db);
    // Columns of later migrations (0011 on) are new and empty too.
    const laterNulls = (t: string, row: object) => {
      const known = new Set([...Object.keys(before[t][0]), ...(t === "scans" ? ["batch_key"] : [])]);
      return Object.fromEntries(Object.keys(row).filter((c) => !known.has(c)).map((c) => [c, null]));
    };
    for (const t of TABLES_WITH_ROWS) {
      const after = raw.prepare(`select * from ${t} order by rowid`).all() as object[];
      expect(after, t).toEqual(before[t].map((r, i) => ({ ...(t === "scans" ? { ...r, batch_key: null } : r), ...laterNulls(t, after[i] ?? {}) })));
    }
    expect(raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    // Old scans belong to no batch: the reports are empty, the scan list reads them as before.
    expect(db.select().from(scans).all().map((s) => s.batchKey)).toEqual([null, null, null]);
    expect(batchReports(db)).toEqual([]);
    expect(recentScans(20, db).map((s) => s.id)).toEqual([3, 2, 1]);
    raw.close();
  });

  it("the build from before this task still starts on the migrated copy and saves scans", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig10-"));
    const file = path.join(dir, "crd.db");
    oldDatabase(file);
    rawOf(createDb(file)).close();
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo0009() });
    expect(old.prepare("insert into scans (mode, status, client_key) values (?, ?, ?)").run("single", "queued", "k2").changes).toBe(1);
    expect(old.prepare("select batch_key from scans where client_key = ?").get("k2")).toEqual({ batch_key: null });
    old.close();
    const again = rawOf(createDb(file));
    expect(again.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({ n: journal().entries.length });
    again.close();
  });
});
