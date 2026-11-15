import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** Open a database file (or ":memory:" in tests) and bring it up to date. */
export function createDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

// Kept on globalThis so development hot reloads reuse one connection.
const holder = globalThis as unknown as { __crdDb?: Db };

/** The app's database. Opened on first use. */
export function getDb(): Db {
  if (!holder.__crdDb) {
    holder.__crdDb = createDb(path.resolve(env().DATA_DIR, "crd.db"));
  }
  return holder.__crdDb;
}

/** For tests only: swap in a throwaway database. */
export function setDbForTests(db: Db | undefined) {
  holder.__crdDb = db;
}

export { schema };
