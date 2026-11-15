// Busy stand-in app: seeds a database and photos, then writes every 200 ms.
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const dir = process.env.DATA_DIR || "/data";
const fresh = !fs.existsSync(`${dir}/crd.db`);
const db = new DatabaseSync(`${dir}/crd.db`);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, name TEXT, cents INTEGER, blob BLOB)");
if (fresh) {
  const ins = db.prepare("INSERT INTO cards (name, cents, blob) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) ins.run(`Card ${i}`, i * 25, crypto.randomBytes(512));
  db.exec("COMMIT");
  fs.mkdirSync(`${dir}/uploads/2026`, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(`${dir}/uploads/2026/photo-${i}.jpg`, crypto.randomBytes(150000));
}
const ins = db.prepare("INSERT INTO cards (name, cents, blob) VALUES (?, ?, ?)");
let n = 0;
setInterval(() => {
  db.exec("BEGIN");
  for (let i = 0; i < 20; i++) ins.run(`Live ${n++}`, n, crypto.randomBytes(256));
  db.exec("COMMIT");
}, 200);
console.log("stand-in Card Vault running");
