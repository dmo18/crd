import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { images } from "@/db/schema";
import { CLEANUP_EVERY_MS, maybeCleanupPhotos, removeOrphanPhotos, resetPhotoCleanup } from "./cleanup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00Z");

let db: Db;
let dir: string;
beforeEach(() => {
  db = createDb(":memory:");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-clean-"));
  resetPhotoCleanup();
});

function file(name: string, ageMs: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x");
  const t = new Date(NOW.getTime() - ageMs);
  fs.utimesSync(full, t, t);
  return name;
}
const left = () => fs.readdirSync(dir).sort();

describe("removeOrphanPhotos", () => {
  it("removes only old files with no database row and leaves other files alone", async () => {
    const id = randomUUID();
    const kept = file(`${id}.jpg`, 3 * DAY);
    const keptThumb = file(`${id}_t.jpg`, 3 * DAY);
    db.insert(images).values({ role: "front", file: kept, thumbFile: keptThumb, width: 1, height: 1, bytes: 1 }).run();
    const orphan = randomUUID();
    file(`${orphan}.jpg`, 2 * DAY);
    file(`${orphan}_t.jpg`, 2 * DAY);
    const fresh = file(`${randomUUID()}.jpg`, 60 * 60 * 1000);
    const other = file("notes.txt", 5 * DAY);

    expect(await removeOrphanPhotos(db, dir, NOW)).toBe(2);
    expect(left()).toEqual([kept, keptThumb, fresh, other].sort());
  });
  it("copes with a missing folder", async () => {
    expect(await removeOrphanPhotos(db, path.join(dir, "missing"), NOW)).toBe(0);
  });
});

describe("maybeCleanupPhotos", () => {
  it("runs at most once a day, even after a restart", async () => {
    const marker = path.join(dir, "..", `crd-marker-${randomUUID()}`);
    file(`${randomUUID()}.jpg`, 2 * DAY);
    expect(await maybeCleanupPhotos({ db, dir, marker, now: NOW })).toBe(1);
    file(`${randomUUID()}.jpg`, 2 * DAY);
    expect(maybeCleanupPhotos({ db, dir, marker, now: new Date(NOW.getTime() + 1000) })).toBeNull();
    // A restart forgets the in-memory time, but the marker file remembers.
    resetPhotoCleanup();
    expect(await maybeCleanupPhotos({ db, dir, marker, now: new Date(NOW.getTime() + 2000) })).toBe(0);
    expect(left()).toHaveLength(1);
    resetPhotoCleanup();
    expect(await maybeCleanupPhotos({ db, dir, marker, now: new Date(NOW.getTime() + CLEANUP_EVERY_MS + 1) })).toBe(1);
    fs.rmSync(marker, { force: true });
  });
});
