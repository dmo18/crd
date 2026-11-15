import { and, asc, count, eq, isNotNull, isNull, like, lt, or, sql, sum } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, scans, type ImageRow } from "@/db/schema";
import { log } from "@/lib/log";
import { ARCHIVE_EDGE, archivePhoto, discardArchive, removeReplaced, SOURCE_ARCHIVE_EDGE } from "./store";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** At most this many photos are converted per minute, so the server stays quick. */
export const ARCHIVE_PER_MINUTE = 10;
/** A failed scan keeps its full quality photos this long, for a retry. */
export const FAILED_KEEP_MS = 7 * DAY;
/** How long to wait before looking again while scans are being read. */
const BUSY_WAIT_MS = 5000;

/** Photos not in their archive form yet: a working copy, or a JPEG from before AVIF. */
export const waitingToConvert = or(isNotNull(images.workFile), like(images.file, "%.jpg"));

type ScanState = { status: string; finishedAt: Date | null; createdAt: Date } | undefined;

/**
 * Whether a photo may be converted now. Never while its scan is queued or
 * being read. A failed scan keeps its photos as they are for 7 days, so a
 * retry reads the full quality copy.
 */
function mayConvert(scan: ScanState, now: Date): boolean {
  if (!scan) return true;
  if (scan.status === "done") return true;
  if (scan.status === "failed") return (scan.finishedAt ?? scan.createdAt).getTime() < now.getTime() - FAILED_KEEP_MS;
  return false;
}

/** The next photos to convert: working copies of finished scans first, then old JPEGs. */
export function photosToConvert(db: Db, now: Date, limit: number): ImageRow[] {
  const failedBefore = now.getTime() - FAILED_KEEP_MS;
  return db.select({ image: images }).from(images).leftJoin(scans, eq(images.scanId, scans.id))
    .where(and(
      waitingToConvert,
      or(
        isNull(images.scanId),
        eq(scans.status, "done"),
        and(eq(scans.status, "failed"), lt(sql`coalesce(${scans.finishedAt}, ${scans.createdAt})`, failedBefore)),
      ),
    ))
    .orderBy(sql`${images.workFile} is null`, asc(images.id))
    .limit(limit).all().map((r) => r.image);
}

/** For tests only: points where a crash is simulated. */
export type ArchiveHooks = { afterWrite?: () => void; afterCommit?: () => void };

/**
 * Converts one photo to its AVIF archive form, in an order that is safe if
 * the server stops at any point: write the new files, then switch the
 * database row in a transaction, then delete the old files. A stop before
 * the switch leaves the row as it was (the step is repeated later); a stop
 * after it leaves only unused old files, which the daily cleanup removes.
 * Returns false when the photo changed meanwhile and nothing was switched.
 */
export async function convertPhoto(db: Db, row: ImageRow, now: Date = new Date(), hooks: ArchiveHooks = {}): Promise<boolean> {
  const edge = row.role === "source" ? SOURCE_ARCHIVE_EDGE : ARCHIVE_EDGE;
  const written = await archivePhoto(row, edge);
  hooks.afterWrite?.();
  const result = db.transaction((tx) => {
    const current = tx.select().from(images).where(eq(images.id, row.id)).get();
    if (!current || current.file !== row.file || current.thumbFile !== row.thumbFile || current.workFile !== row.workFile) {
      return { ok: false as const, current };
    }
    const scan = current.scanId == null ? undefined
      : tx.select({ status: scans.status, finishedAt: scans.finishedAt, createdAt: scans.createdAt }).from(scans).where(eq(scans.id, current.scanId)).get();
    if (!mayConvert(scan, now)) return { ok: false as const, current };
    tx.update(images).set(written).where(eq(images.id, row.id)).run();
    return { ok: true as const, current };
  }, { behavior: "immediate" });
  if (!result.ok) {
    await discardArchive(written, result.current);
    return false;
  }
  hooks.afterCommit?.();
  await removeReplaced(row, written);
  return true;
}

/** Converts every waiting photo of one finished scan straight away. Returns how many were converted. */
export async function convertScanPhotos(scanId: number, db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const rows = db.select().from(images).where(and(eq(images.scanId, scanId), waitingToConvert)).orderBy(asc(images.id)).all();
  let done = 0;
  for (const row of rows) {
    try {
      if (await convertPhoto(db, row, now)) done += 1;
    } catch {
      // Left waiting; the background converter tries again.
    }
  }
  return done;
}

export type ArchiverDeps = {
  db?: Db;
  /** True while scans are being read; conversion waits so card reading stays quick. */
  busy?: () => boolean;
  perMinute?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

const holder = globalThis as unknown as { __crdArchiver?: { running: boolean; again: boolean } };

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Starts the background converter unless it is already running. It converts
 * photos in the order photosToConvert gives, at most `perMinute` per minute,
 * pauses while scans are being read, and stops when nothing is waiting.
 * Progress lives in the database, so after a restart it simply carries on.
 * Never throws. Returns how many photos it converted (for tests), or null
 * when it was already running.
 */
export function startPhotoArchiver(deps: ArchiverDeps = {}): Promise<number> | null {
  const state = (holder.__crdArchiver ??= { running: false, again: false });
  if (state.running) {
    state.again = true;
    return null;
  }
  state.running = true;
  const perMinute = deps.perMinute ?? ARCHIVE_PER_MINUTE;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const busy = deps.busy ?? (() => false);
  return (async () => {
    let converted = 0;
    const skip = new Set<number>();
    let windowStart = Date.now();
    let inWindow = 0;
    try {
      const db = deps.db ?? getDb();
      for (;;) {
        state.again = false;
        if (busy()) {
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        const next = photosToConvert(db, now(), skip.size + 1).find((r) => !skip.has(r.id));
        if (!next) {
          if (state.again) continue;
          break;
        }
        if (inWindow >= perMinute) {
          const wait = windowStart + MINUTE - Date.now();
          if (wait > 0) await sleep(wait);
          windowStart = Date.now();
          inWindow = 0;
          continue;
        }
        inWindow += 1;
        try {
          if (await convertPhoto(db, next, now())) converted += 1;
          else skip.add(next.id);
        } catch {
          // A missing or unreadable file: leave it for the next run.
          skip.add(next.id);
        }
      }
      if (converted > 0) log.info("photos_converted", { converted });
    } catch {
      // Never fails a page; the next start carries on.
    } finally {
      state.running = false;
    }
    return converted;
  })();
}

/** For tests only. */
export function resetPhotoArchiver(): void {
  holder.__crdArchiver = undefined;
}

export type StorageSummary = {
  photos: number;
  totalBytes: number;
  items: number;
  /** Total divided by the number of items, or null with no items. */
  perItemBytes: number | null;
  waiting: number;
};

/** Photo storage for the More page, from the sizes recorded with each photo. */
export function storageSummary(db: Db = getDb()): StorageSummary {
  const all = db.select({ photos: count(), main: sum(images.bytes), thumbs: sum(images.thumbBytes) }).from(images).get();
  const waiting = db.select({ n: count() }).from(images).where(waitingToConvert).get()?.n ?? 0;
  const itemCount = db.select({ n: count() }).from(items).get()?.n ?? 0;
  const totalBytes = Number(all?.main ?? 0) + Number(all?.thumbs ?? 0);
  return {
    photos: all?.photos ?? 0,
    totalBytes,
    items: itemCount,
    perItemBytes: itemCount > 0 ? Math.round(totalBytes / itemCount) : null,
    waiting,
  };
}

/** Plain size text, like "350 KB" or "1.2 GB". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))} ${units[i]}`;
}
