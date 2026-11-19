import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, scans, valuations, type ImageRow, type ValueSource } from "@/db/schema";
import { startPhotoArchiver } from "@/lib/images/archive";
import { cropStored, ImageError, readForRecognition, type StoredImage } from "@/lib/images/store";
import { serializeCatalog } from "@/lib/catalog/candidates";
import { applyScanCard, autoLinkIn } from "@/lib/catalog/pick";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { getRecognizer } from "@/lib/recognition";
import { checkScanStreak } from "@/lib/audit/alert-rules";
import { errorKind, log } from "@/lib/log";
import { keepReaderSamples } from "./samples";
import { recordSnapshot } from "@/lib/valuation/snapshots";
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
    const crops = new Map<number, StoredImage>();
    if (scan.mode === "multi") {
      for (const [i, r] of recognized.entries()) {
        const source: ImageRow | undefined = photoRows[r.sourceIndex];
        if (!r.box || !source) continue;
        try {
          crops.set(i, await cropStored(source, r.box));
        } catch {
          // A bad box only costs this item its own picture.
        }
      }
    }

    const valueSource: ValueSource = recognizer.name === "sample" ? "sample" : "ai_estimate";
    const at = now();
    db.transaction((tx) => {
      recognized.forEach((r: RecognizedItem, i: number) => {
        const row = itemFromRecognition(r, { scanId, locationId: scan.locationId, valueSource, now: at, recognizer: recognizer.name });
        const item = tx.insert(items).values(row).returning().get();
        if (r.kind === "card" && r.catalog?.status === "sure") fileSureCard(tx as unknown as Db, item, r.catalog, at);
        if (r.kind === "card" && r.catalog?.status === "matched") linkVerifiedMatch(tx as unknown as Db, item.id, at);
        if (row.estValueCents != null) {
          tx.insert(valuations).values({
            itemId: item.id, source: valueSource, lowCents: row.estLowCents, highCents: row.estHighCents,
            valueCents: row.estValueCents, basis: row.valueBasis, createdAt: at,
          }).run();
        }
        const crop = crops.get(i);
        if (crop) tx.insert(images).values({ itemId: item.id, scanId, role: "crop", ...crop }).run();
      });
      // One-item scans: the photos themselves belong to that item.
      if (scan.mode !== "multi" && recognized.length === 1) {
        // Not filtered by liveItem: the item was made a moment ago in this transaction.
        const only = tx.select({ id: items.id }).from(items).where(eq(items.scanId, scanId)).get();
        if (only) tx.update(images).set({ itemId: only.id }).where(eq(images.scanId, scanId)).run();
      }
      tx.update(scans).set({ status: "done", itemCount: recognized.length, recognizer: recognizer.name, finishedAt: at, error: null })
        .where(eq(scans.id, scanId)).run();
    });
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
 * A sure catalog card is kept and applied by the filling rule, in a savepoint
 * of its own: when it cannot be kept, the card is left as a candidate for
 * Review and the scan goes on with its reading. Never throws.
 */
function fileSureCard(tx: Db, item: typeof items.$inferSelect, part: { card: RecognizedCatalogCard; confidence: number }, at: Date): void {
  try {
    const applied = tx.transaction((sp) => applyScanCard(sp as unknown as Db, item, part.card, part.confidence, at));
    if (applied) return;
  } catch (err) {
    log.warn("catalog_apply_failed", { itemId: item.id, error: errorKind(err) });
  }
  try {
    tx.update(items).set({ catalogCandidates: serializeCatalog({ status: "candidates", items: [part.card] }, at) }).where(eq(items.id, item.id)).run();
  } catch {
    // The reading stands as it is.
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
type RecognizedCatalogCard = Extract<NonNullable<RecognizedItem["catalog"]>, { status: "sure" }>["card"];

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
