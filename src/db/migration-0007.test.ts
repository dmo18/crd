import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { listItems, inventoryFilterSchema } from "@/lib/items/query";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

/** A copy of the migrations folder that stops at 0006, as on the live site before 9.6. */
function migrationsUpTo0006(): string {
  const out = path.join(dir, "drizzle");
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 6);
  expect(journal.entries).toHaveLength(7);
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[]) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  return out;
}

describe("migration 0007", () => {
  it("applies to a 0006 database with rows in it, keeps every row and leaves them all live", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-mig-"));
    const file = path.join(dir, "crd.db");
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo0006() });
    const cols = (t: string) => (old.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("items")).not.toContain("deleted_at");
    expect(cols("scans")).toContain("client_key");

    old.prepare("insert into locations (name) values (?)").run("Box 1");
    old.prepare("insert into scans (mode, status, client_key) values (?, ?, ?)").run("single", "done", "k1");
    const add = old.prepare("insert into items (kind, status, scan_id, title, player, quantity, location_id, manual_value_cents) values (?, ?, ?, ?, ?, ?, ?, ?)");
    add.run("card", "confirmed", 1, "1989 Upper Deck Ken Griffey Jr.", "Ken Griffey Jr.", 2, 1, 1500);
    add.run("sealed", "needs_review", null, "1990 Topps wax box", null, 1, null, null);
    old.prepare("insert into images (item_id, scan_id, role, file, thumb_file, width, height, bytes) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, 1, "front", "a.avif", "a-thumb.avif", 900, 1200, 1000);
    old.prepare("insert into valuations (item_id, source, value_cents) values (?, ?, ?)").run(1, "manual", 1500);
    const before = old.prepare("select * from items order by id").all();
    old.close();

    // The app's normal start: opens the file and applies what is missing (0007).
    const db = createDb(file);
    const raw = (db as unknown as { $client: Database.Database }).$client;
    const after = raw.prepare("select * from items order by id").all() as Record<string, unknown>[];
    expect(after).toHaveLength(2);
    after.forEach((row, i) => expect(row).toEqual({ ...(before[i] as object), deleted_at: null }));
    expect(raw.prepare("select count(*) as n from images").get()).toEqual({ n: 1 });
    expect(raw.prepare("select count(*) as n from valuations").get()).toEqual({ n: 1 });
    expect(raw.prepare("select count(*) as n from scans").get()).toEqual({ n: 1 });
    expect(raw.prepare("select count(*) as n from bulk_ops").get()).toEqual({ n: 0 });
    const indexes = (raw.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["items_deleted_idx", "bulk_ops_at_idx", "scans_client_key_uq"]));
    // Both old rows show in the inventory.
    expect(listItems(inventoryFilterSchema.parse({}), db).total).toBe(2);
    raw.close();
  });
});
