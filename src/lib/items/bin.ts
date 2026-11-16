import fs from "node:fs/promises";
import path from "node:path";
import { and, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items } from "@/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { deletePhotoFiles, removeItemRows } from "./remove";

/** Days an item stays in Recently deleted before it is removed for good. */
export const BIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ids handled per database statement, well under SQLite's limit on values. */
const CHUNK = 500;

function chunks(ids: number[]): number[][] {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  const out: number[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) out.push(unique.slice(i, i + CHUNK));
  return out;
}

/**
 * Moves items to Recently deleted. Rows, photos and value history all stay.
 * Items already there keep their first deletion time. Returns how many moved.
 */
export function softDeleteItems(ids: number[], db: Db = getDb(), now: Date = new Date()): number {
  const parts = chunks(ids);
  if (parts.length === 0) return 0;
  return db.transaction((tx) => {
    let changed = 0;
    for (const part of parts) {
      changed += tx.update(items).set({ deletedAt: now })
        .where(and(inArray(items.id, part), isNull(items.deletedAt))).run().changes;
    }
    return changed;
  }, { behavior: "immediate" });
}

/**
 * Puts items from Recently deleted back in the collection, with the photos
 * and value history they kept. Reads deleted rows on purpose (restore).
 * Ids that are not in the bin are skipped. Returns how many came back.
 */
export function restoreItems(ids: number[], db: Db = getDb()): number {
  const parts = chunks(ids);
  if (parts.length === 0) return 0;
  return db.transaction((tx) => {
    let changed = 0;
    for (const part of parts) {
      changed += tx.update(items).set({ deletedAt: null })
        .where(and(inArray(items.id, part), isNotNull(items.deletedAt))).run().changes;
    }
    return changed;
  }, { behavior: "immediate" });
}

/**
 * Removes items in Recently deleted for good: their rows in one transaction,
 * then their photo files. Only items already in the bin are touched; a live
 * item in the list is skipped. Returns how many were removed.
 */
export async function purgeItems(ids: number[], db: Db = getDb()): Promise<number> {
  const parts = chunks(ids);
  if (parts.length === 0) return 0;
  const { removed, files } = db.transaction((tx) => {
    const t = tx as unknown as Db;
    let count = 0;
    const toDelete: string[] = [];
    for (const part of parts) {
      // Reads deleted rows on purpose (purge).
      const inBin = t.select({ id: items.id }).from(items)
        .where(and(inArray(items.id, part), isNotNull(items.deletedAt))).all();
      for (const { id } of inBin) {
        const f = removeItemRows(t, id);
        if (f) { count += 1; toDelete.push(...f); }
      }
    }
    return { removed: count, files: toDelete };
  }, { behavior: "immediate" });
  await deletePhotoFiles(files);
  return removed;
}

/** Removes for good every item deleted at least BIN_DAYS days before `now`. Returns how many. */
export async function purgeExpired(db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BIN_DAYS * DAY_MS);
  // Reads deleted rows on purpose (purge).
  const ids = db.select({ id: items.id }).from(items)
    .where(and(isNotNull(items.deletedAt), lte(items.deletedAt, cutoff))).all().map((r) => r.id);
  return purgeItems(ids, db);
}

/** Days left before an item deleted at `deletedAt` is removed for good. Never below 0. */
export function daysLeft(deletedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((deletedAt.getTime() + BIN_DAYS * DAY_MS - now.getTime()) / DAY_MS));
}

const EVERY_MS = DAY_MS;
const holder = globalThis as unknown as { __crdBinPurge?: { lastRun: number; running: boolean } };

/**
 * Starts the purge of old Recently deleted items in the background when it
 * has not run in the last day (same pattern as maybeCleanupPhotos). The time
 * of the last run is kept in a small file in DATA_DIR. Never throws.
 */
export function maybePurgeBin(deps: { db?: Db; now?: Date; marker?: string } = {}): Promise<number> | null {
  const now = deps.now ?? new Date();
  const state = (holder.__crdBinPurge ??= { lastRun: Number.NEGATIVE_INFINITY, running: false });
  if (state.running || now.getTime() - state.lastRun < EVERY_MS) return null;
  state.running = true;
  state.lastRun = now.getTime();
  const marker = deps.marker ?? path.resolve(env().DATA_DIR, ".bin-purge");
  return (async () => {
    try {
      const saved = Number((await fs.readFile(/*turbopackIgnore: true*/ marker, "utf8").catch(() => "")).trim());
      if (Number.isFinite(saved) && saved > 0 && now.getTime() - saved < EVERY_MS) {
        state.lastRun = saved;
        return 0;
      }
      await fs.writeFile(/*turbopackIgnore: true*/ marker, String(now.getTime()));
      const removed = await purgeExpired(deps.db ?? getDb(), now);
      if (removed > 0) log.info("bin_purge", { removed });
      return removed;
    } catch {
      return 0;
    } finally {
      state.running = false;
    }
  })();
}

/** For tests only. */
export function resetBinPurge(): void {
  holder.__crdBinPurge = undefined;
}
