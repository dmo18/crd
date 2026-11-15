import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { images, items, scans, valuations, type ImageRow, type ValueSource } from "@/db/schema";
import { cropStored, ImageError, readStored, type StoredImage } from "@/lib/images/store";
import { itemFromRecognition } from "@/lib/items/from-recognition";
import { getRecognizer } from "@/lib/recognition";
import { recordSnapshot } from "@/lib/valuation/snapshots";
import { RecognitionError, type RecognitionPhoto, type RecognizedItem, type Recognizer } from "@/lib/recognition/types";

const GENERIC_FAILURE = "Something went wrong with this scan. Try again.";
/** A scan still "processing" after this long was interrupted by a restart. */
const STUCK_AFTER_MS = 5 * 60 * 1000;

export type ProcessDeps = { db?: Db; recognizer?: Recognizer; now?: () => Date };

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
  const scan = db.update(scans).set({ status: "processing" })
    .where(and(eq(scans.id, scanId), eq(scans.status, "queued"))).returning().get();
  if (!scan) return;

  try {
    const recognizer = deps.recognizer ?? getRecognizer();
    const photoRows = db.select().from(images)
      .where(and(eq(images.scanId, scanId), inArray(images.role, ["front", "back", "source"]), isNull(images.itemId)))
      .orderBy(asc(images.id)).all();
    if (photoRows.length === 0) throw new RecognitionError("This scan has no photos. Try again.");

    const photos: RecognitionPhoto[] = [];
    for (const row of photoRows) {
      photos.push({ role: row.role as RecognitionPhoto["role"], data: await readStored(row.file), width: row.width, height: row.height });
    }

    const recognized = await recognizer.recognize({ mode: scan.mode, photos, hint: scan.hint });

    // Cut each card out of a multi-card photo before touching the database.
    const crops = new Map<number, StoredImage>();
    if (scan.mode === "multi") {
      for (const [i, r] of recognized.entries()) {
        const source: ImageRow | undefined = photoRows[r.sourceIndex];
        if (!r.box || !source) continue;
        try {
          crops.set(i, await cropStored(source.file, r.box));
        } catch {
          // A bad box only costs this item its own picture.
        }
      }
    }

    const valueSource: ValueSource = recognizer.name === "sample" ? "sample" : "ai_estimate";
    const at = now();
    db.transaction((tx) => {
      recognized.forEach((r: RecognizedItem, i: number) => {
        const row = itemFromRecognition(r, { scanId, locationId: scan.locationId, valueSource, now: at });
        const item = tx.insert(items).values(row).returning({ id: items.id }).get();
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
    console.error(`scan ${scanId} failed: ${err instanceof Error ? err.name : "unknown error"}`);
    db.update(scans).set({ status: "failed", error: safeMessage(err), finishedAt: now() }).where(eq(scans.id, scanId)).run();
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
  q.tail = q.tail.then(() => processScan(scanId, deps)).catch(() => undefined).finally(() => { q.pending.delete(scanId); });
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
    .where(and(eq(scans.status, "processing"), lt(scans.createdAt, stuckBefore))).all()
    .filter((s) => !q.pending.has(s.id));
  if (stuck.length) {
    db.update(scans).set({ status: "queued" }).where(inArray(scans.id, stuck.map((s) => s.id))).run();
  }
  const waiting = db.select({ id: scans.id }).from(scans).where(eq(scans.status, "queued")).orderBy(asc(scans.id)).all();
  for (const s of waiting) enqueueScan(s.id, deps);
}
