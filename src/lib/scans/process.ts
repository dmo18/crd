import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { UncutPhoto } from "@/lib/catalog/sources";
import { getDb, type Db } from "@/db";
import { images, items, scans, valuations, type ImageRow, type ValueSource } from "@/db/schema";
import { startPhotoArchiver } from "@/lib/images/archive";
import { fixPhoto } from "@/lib/items/photos";
import { planFix } from "./photo-fix";
import { cropStored, cutStored, ImageError, readForRecognition, type StoredImage } from "@/lib/images/store";
import { autoLinkIn } from "@/lib/catalog/pick";
import { holdIfDuplicate } from "@/lib/items/duplicates";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { getRecognizer } from "@/lib/recognition";
import { checkScanStreak } from "@/lib/audit/alert-rules";
import { errorKind, log } from "@/lib/log";
import { keepReaderSamples } from "./samples";
import { recordSnapshot } from "@/lib/valuation/snapshots";
import { refreshGuideQuietly } from "@/lib/valuation/guide/apply";
import { RecognitionError, type RecognitionPhoto, type RecognizedItem, type Recognizer } from "@/lib/recognition/types";

const GENERIC_FAILURE = "Something went wrong with this scan. Try again.";
/** A scan still "processing" this long after it started was interrupted by a restart. */
const STUCK_AFTER_MS = 5 * 60 * 1000;

/** Longest time recognition may take for one scan. */
export const RECOGNITION_DEADLINE_MS = 5 * 60 * 1000;
export const TOO_SLOW = "This scan took too long. Try fewer cards per photo.";

export type ProcessDeps = { db?: Db; recognizer?: Recognizer; now?: () => Date; deadlineMs?: number };

/**
 * Resolves or rejects like `work`, or rejects with a plain message once
 * `ms` have passed. The timer is always cleared. The recognizer contract has
 * no way to cancel, so slow work may finish in the background; its result is
 * ignored.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecognitionError(TOO_SLOW)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The turn for a stored card crop, only when the reader trusted it. Many cards: nothing else is done. */
function turnOf(r: RecognizedItem, role: "front" | "back"): 0 | 90 | 180 | 270 {
  const fix = r.fixes?.find((f) => f.role === role);
  return fix && fix.turnTrusted ? fix.turn : 0;
}

/**
 * Many cards: the one card rules (planFix) for a cut-out of `width` by
 * `height`. The cut-out is already the card along its own outline, so that
 * is its card box: nothing more is cut off (the finder inside a cut-out can
 * miss a dark card edge), and its shape counts for the turn.
 */
function planOf(r: RecognizedItem, role: "front" | "back") {
  const fix = r.fixes?.find((f) => f.role === role);
  return (width: number, height: number) => (fix ? planFix({ ...fix, card: { x: 0, y: 0, w: 1, h: 1 }, cardTrusted: true }, width, height) : null);
}

/**
 * Applies what the reader found to each photo of a one card scan. A failure
 * here never fails the scan: the kind of error is logged and that photo stays
 * as it was.
 */
async function fixScanPhotos(db: Db, rows: ImageRow[], item: RecognizedItem): Promise<UncutPhoto[]> {
  // The photos not cut to the card: the item page offers "Trim the photo" for them.
  const uncut: UncutPhoto[] = [];
  const note = (row: ImageRow) => {
    const now = db.select({ width: images.width, height: images.height }).from(images).where(eq(images.id, row.id)).get();
    if (now && !uncut.some((u) => u.id === row.id)) uncut.push({ id: row.id, w: now.width, h: now.height });
  };
  const cut = new Set<number>();
  for (const fix of item.fixes ?? []) {
    const row = rows[fix.sourceIndex];
    if (!row) continue;
    try {
      const plan = planFix(fix, row.width, row.height);
      if (!plan) { note(row); continue; }
      const result = await fixPhoto(row, plan, db);
      if (!result.ok) log.warn("photo_fix_skipped", { scanId: row.scanId, imageId: row.id });
      if (!result.ok || !plan.box) note(row);
      else cut.add(row.id);
    } catch (err) {
      log.warn("photo_fix_failed", { scanId: row.scanId, error: errorKind(err) });
      note(row);
    }
  }
  // A photo the reader gave no fix for (no card found in it) was not cut either.
  for (const row of rows) if ((row.role === "front" || row.role === "back") && !cut.has(row.id)) note(row);
  return uncut;
}

function safeMessage(err: unknown): string {
  if (err instanceof RecognitionError || err instanceof ImageError) return err.userMessage;
  return GENERIC_FAILURE;
}

/**
 * Runs recognition for one queued scan and files the results as items.
 * Never throws: a failure is recorded on the scan with a safe message.
 */
export async function processScan(scanId: number, deps: ProcessDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? (() => new Date());

  // Claim the scan. If it is not queued (already running or finished) do nothing.
  const scan = db.update(scans).set({ status: "processing", startedAt: now() })
    .where(and(eq(scans.id, scanId), eq(scans.status, "queued"))).returning().get();
  if (!scan) return;

  try {
    const recognizer = deps.recognizer ?? getRecognizer();
    const photoRows = db.select().from(images)
      .where(and(eq(images.scanId, scanId), inArray(images.role, ["front", "back", "source"]), isNull(images.itemId)))
      .orderBy(asc(images.id)).all();
    if (photoRows.length === 0) throw new RecognitionError("This scan has no photos. Try again.");

    // Always the full quality working copy when it exists, never the small archive.
    const photos: RecognitionPhoto[] = [];
    for (const row of photoRows) {
      photos.push({ role: row.role as RecognitionPhoto["role"], ...(await readForRecognition(row)) });
    }

    await keepReaderSamples(scanId, photos);

    const work = recognizer.recognize({ mode: scan.mode, photos, hint: scan.hint });
    // A late failure after the deadline must not become an unhandled rejection.
    work.catch(() => undefined);
    const recognized = await withDeadline(work, deps.deadlineMs ?? RECOGNITION_DEADLINE_MS);

    // Cut each card out of a multi-card photo before touching the database,
    // from the working copy. The archive copies are made afterwards by the
    // background converter (startPhotoArchiver), once no scan is waiting.
    // A card whose back was found in another photo of the scan (12R.7) gets
    // that part as its back photo, the way a one card scan keeps its back.
    const crops = new Map<number, StoredImage>();
    const backs = new Map<number, StoredImage>();
    if (scan.mode === "multi") {
      for (const [i, r] of recognized.entries()) {
        const source: ImageRow | undefined = photoRows[r.sourceIndex];
        if (r.box && source) {
          try {
            // Cut along the card's own outline as it was read, then the one card rules (planFix): no neighbour shows.
            const cut = r.cuts?.front;
            crops.set(i, cut ? await cutStored(source, cut, planOf(r, "front")) : await cropStored(source, r.box, undefined, turnOf(r, "front")));
          } catch {
            // A bad box only costs this item its own picture.
          }
        }
        const back = r.backPhoto;
        const backSource: ImageRow | undefined = back ? photoRows[back.sourceIndex] : undefined;
        if (back && backSource) {
          try {
            const cut = r.cuts?.back;
            backs.set(i, cut ? await cutStored(backSource, cut, planOf(r, "back")) : await cropStored(backSource, back.box, undefined, turnOf(r, "back")));
          } catch {
            // The card keeps its front; the back can be added later.
          }
        }
      }
    }

    // One card scans: turn each stored photo upright and cut it to the card
    // when the reader is sure (S1b). The untouched photo stays as the original.
    let uncut: UncutPhoto[] = [];
    if (scan.mode === "single" && recognized.length === 1) {
      uncut = await fixScanPhotos(db, photoRows, recognized[0]!);
    }

    const valueSource: ValueSource = recognizer.name === "sample" ? "sample" : "ai_estimate";
    const at = now();
    db.transaction((tx) => {
      const made: number[] = [];
      recognized.forEach((r: RecognizedItem, i: number) => {
        const row = itemFromRecognition(r, { scanId, locationId: scan.locationId, valueSource, now: at, recognizer: recognizer.name, uncut });
        const item = tx.insert(items).values(row).returning().get();
        made.push(item.id);
        if (r.kind === "card" && r.catalog?.status === "matched") linkVerifiedMatch(tx as unknown as Db, item.id, at);
        if (row.estValueCents != null) {
          tx.insert(valuations).values({
            itemId: item.id, source: valueSource, lowCents: row.estLowCents, highCents: row.estHighCents,
            valueCents: row.estValueCents, basis: row.valueBasis, createdAt: at,
          }).run();
        }
        const crop = crops.get(i);
        // The cut-out is the card's front (role crop, shown as Front), or its back when only the back was found.
        if (crop) tx.insert(images).values({ itemId: item.id, scanId, role: r.cropSide === "back" ? "back" : "crop", ...crop }).run();
        const back = backs.get(i);
        if (back) tx.insert(images).values({ itemId: item.id, scanId, role: "back", ...back }).run();
      });
      // A card that may be one already in the collection (or another card of this scan) waits in Review.
      for (const id of made) holdIfDuplicate(id, tx as unknown as Db);
      // One-item scans: the photos themselves belong to that item.
      if (scan.mode !== "multi" && recognized.length === 1) {
        // Not filtered by liveItem: the item was made a moment ago in this transaction.
        const only = tx.select({ id: items.id }).from(items).where(eq(items.scanId, scanId)).get();
        if (only) tx.update(images).set({ itemId: only.id }).where(eq(images.scanId, scanId)).run();
      }
      tx.update(scans).set({ status: "done", itemCount: recognized.length, recognizer: recognizer.name, finishedAt: at, error: null })
        .where(eq(scans.id, scanId)).run();
    });
    // The built-in price guide for each new item. Never fails the scan.
    refreshGuideQuietly(db.select({ id: items.id }).from(items).where(eq(items.scanId, scanId)).all().map((r) => r.id), db, at);
    try {
      recordSnapshot(db, at);
    } catch {
      // The value chart can catch up later. It must never fail a scan.
    }
  } catch (err) {
    // Log the kind of failure only. Never photo data, hints or keys.
    log.error("scan_failed", { scanId, error: errorKind(err) });
    db.update(scans).set({ status: "failed", error: safeMessage(err), finishedAt: now() }).where(eq(scans.id, scanId)).run();
    await checkScanStreak(db);
  }
}

/**
 * Exactly one verified match (S1a rule C): linked as "This is my card" would,
 * in a savepoint of its own. When it cannot be linked, the list stays for
 * the owner's tap and the scan goes on. Never throws.
 */
function linkVerifiedMatch(tx: Db, itemId: number, at: Date): void {
  try {
    tx.transaction((sp) => { autoLinkIn(sp as unknown as Db, itemId, at); });
  } catch (err) {
    log.warn("catalog_match_link_failed", { itemId, error: errorKind(err) });
  }
}

// One scan is processed at a time, in the order received, inside this server.
const holder = globalThis as unknown as { __crdQueue?: { tail: Promise<void>; pending: Set<number> } };
function queue() {
  holder.__crdQueue ??= { tail: Promise.resolve(), pending: new Set() };
  return holder.__crdQueue;
}

/** Adds a scan to the background queue and returns straight away. */
export function enqueueScan(scanId: number, deps: ProcessDeps = {}): void {
  const q = queue();
  if (q.pending.has(scanId)) return;
  q.pending.add(scanId);
  q.tail = q.tail.then(() => processScan(scanId, deps)).catch(() => undefined).finally(() => {
    q.pending.delete(scanId);
    // Turn this scan's photos into their small archive form once the queue is
    // empty. Tests pass their own database and convert explicitly.
    if (!deps.db) void startPhotoArchiver({ busy: scanQueueBusy });
  });
}

/**
 * Scan ids in this server's queue, in the order they will run. The first one
 * is being processed (or about to be).
 */
export function queueOrder(): number[] {
  return [...queue().pending];
}

export type RetryResult = { ok: true } | { ok: false; status: 404 | 409 | 410; error: string };

/**
 * Puts a failed scan back in the queue with the photos it already has, so a
 * retry never uploads a second copy. Call enqueueScan after it succeeds.
 */
export function retryScan(scanId: number, db: Db = getDb()): RetryResult {
  return db.transaction((tx): RetryResult => {
    const scan = tx.select({ status: scans.status }).from(scans).where(eq(scans.id, scanId)).get();
    if (!scan) return { ok: false, status: 404, error: "Scan not found." };
    if (scan.status !== "failed") return { ok: false, status: 409, error: "This scan is still going or already finished." };
    const photo = tx.select({ id: images.id }).from(images)
      .where(and(eq(images.scanId, scanId), inArray(images.role, ["front", "back", "source"]), isNull(images.itemId))).get();
    if (!photo) return { ok: false, status: 410, error: "The photos for this scan are gone. Take them again." };
    tx.update(scans).set({ status: "queued", error: null, startedAt: null, finishedAt: null })
      .where(and(eq(scans.id, scanId), eq(scans.status, "failed"))).run();
    return { ok: true };
  }, { behavior: "immediate" });
}

/** True while any scan waits in or is being read by this server's queue. */
export function scanQueueBusy(): boolean {
  return queue().pending.size > 0;
}

/** Resolves when everything queued so far has finished. Used by tests. */
export function queueIdle(): Promise<void> {
  return queue().tail;
}

/**
 * Picks up scans that were queued or interrupted when the server restarted.
 * Cheap to call often.
 */
export function recoverScans(deps: ProcessDeps = {}): void {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const q = queue();
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = db.select({ id: scans.id }).from(scans)
    .where(and(eq(scans.status, "processing"), lt(sql`coalesce(${scans.startedAt}, ${scans.createdAt})`, stuckBefore.getTime()))).all()
    .filter((s) => !q.pending.has(s.id));
  if (stuck.length) {
    db.update(scans).set({ status: "queued", startedAt: null }).where(inArray(scans.id, stuck.map((s) => s.id))).run();
  }
  const waiting = db.select({ id: scans.id }).from(scans).where(eq(scans.status, "queued")).orderBy(asc(scans.id)).all();
  for (const s of waiting) enqueueScan(s.id, deps);
}
