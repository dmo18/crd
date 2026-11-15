import fs from "node:fs/promises";
import path from "node:path";
import { eq, or } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images } from "@/db/schema";
import { env } from "@/lib/env";
import { isValidImageName, uploadsDir } from "./store";

const HOUR = 60 * 60 * 1000;
/** A photo file must be at least this old before it counts as left over. Uploads in progress are younger. */
export const ORPHAN_MIN_AGE_MS = 24 * HOUR;
/** The cleanup runs at most this often. */
export const CLEANUP_EVERY_MS = 24 * HOUR;

/**
 * Deletes photo files in the uploads folder that no database row points at
 * and that are older than 24 hours. Only names the server itself generates
 * are considered, so nothing else in the folder is ever touched. Returns how
 * many files were removed.
 */
export async function removeOrphanPhotos(db: Db = getDb(), dir: string = uploadsDir(), now: Date = new Date()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const known = new Set<string>();
  for (const r of db.select({ file: images.file, thumb: images.thumbFile }).from(images).all()) {
    known.add(r.file);
    known.add(r.thumb);
  }
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
  let removed = 0;
  for (const name of names) {
    if (!isValidImageName(name) || known.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      // Check again right before deleting, in case a row was written meanwhile.
      if (db.select({ id: images.id }).from(images).where(or(eq(images.file, name), eq(images.thumbFile, name))).get()) continue;
      await fs.rm(full, { force: true });
      removed += 1;
    } catch {
      // Skip this one; the next run tries again.
    }
  }
  return removed;
}

const holder = globalThis as unknown as { __crdPhotoCleanup?: { lastRun: number; running: boolean } };

function markerFile(): string {
  return path.resolve(env().DATA_DIR, ".photo-cleanup");
}

/**
 * Starts the cleanup in the background when it has not run in the last day.
 * The time of the last run is kept in a small file in DATA_DIR, so a restart
 * does not run it again early. Cheap to call on every page view; never throws.
 */
export function maybeCleanupPhotos(deps: { db?: Db; now?: Date; marker?: string; dir?: string } = {}): Promise<number> | null {
  const now = deps.now ?? new Date();
  const state = (holder.__crdPhotoCleanup ??= { lastRun: Number.NEGATIVE_INFINITY, running: false });
  if (state.running || now.getTime() - state.lastRun < CLEANUP_EVERY_MS) return null;
  state.running = true;
  state.lastRun = now.getTime();
  const marker = deps.marker ?? markerFile();
  const run = (async () => {
    try {
      const saved = Number((await fs.readFile(/*turbopackIgnore: true*/ marker, "utf8").catch(() => "")).trim());
      if (Number.isFinite(saved) && saved > 0 && now.getTime() - saved < CLEANUP_EVERY_MS) {
        state.lastRun = saved;
        return 0;
      }
      await fs.writeFile(/*turbopackIgnore: true*/ marker, String(now.getTime()));
      const removed = await removeOrphanPhotos(deps.db ?? getDb(), deps.dir ?? uploadsDir(), now);
      if (removed > 0) console.info(`photo cleanup removed ${removed} unused files`);
      return removed;
    } catch {
      return 0;
    } finally {
      state.running = false;
    }
  })();
  return run;
}

/** For tests only. */
export function resetPhotoCleanup(): void {
  holder.__crdPhotoCleanup = undefined;
}
