// Stand-in for scripts/backup-db.mjs: SQLite online backup with node:sqlite.
import { DatabaseSync, backup } from "node:sqlite";
const [src, dest] = process.argv.slice(2);
const db = new DatabaseSync(src);
await backup(db, dest);
db.close();
console.log(`Database copied to ${dest}`);
