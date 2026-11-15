// Online SQLite backup: node scripts/backup-db.mjs <source db> <destination file>
// Safe to run while the app is running (uses SQLite's own backup, not a file copy).
import fs from "node:fs";
import Database from "better-sqlite3";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error("Usage: node scripts/backup-db.mjs <source db> <destination file>");
  process.exit(2);
}

const db = new Database(src, { fileMustExist: true });
try {
  db.pragma("busy_timeout = 5000");
  await db.backup(dest);
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : "unknown error"}`);
  fs.rmSync(dest, { force: true });
  process.exitCode = 1;
} finally {
  db.close();
}
if (!process.exitCode) console.log(`Database copied to ${dest}`);
