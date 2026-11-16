import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { env } from "@/lib/env";
import { textReaderStatus } from "@/lib/free/ocr";
import type { ReaderStatus } from "@/lib/free/ocr-worker";

/** The data folder write test runs at most this often; the answer is reused in between. */
export const WRITE_CHECK_EVERY_MS = 60 * 1000;

const holder = globalThis as unknown as { __crdHealthWrite?: Map<string, { at: number; ok: boolean }> };

function canWrite(dir: string, now: number): boolean {
  const cache = (holder.__crdHealthWrite ??= new Map());
  const last = cache.get(dir);
  if (last && now - last.at < WRITE_CHECK_EVERY_MS && now >= last.at) return last.ok;
  let ok: boolean;
  try {
    const probe = path.join(dir, `.health-${randomBytes(6).toString("hex")}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    ok = true;
  } catch {
    ok = false;
  }
  cache.set(dir, { at: now, ok });
  return ok;
}

export type Health = { ok: boolean; reader: ReaderStatus };

/**
 * Is the app able to do its job? Checks that the database answers (every
 * call) and that the data folder can be written (at most once a minute, so a
 * watchdog polling often does not write to disk each time). Also says
 * whether the text reader is up: "ready", "waiting" (not started yet, it
 * starts with the first scan) or "down" (it stopped and starts again with the
 * next scan). The reader does not change `ok`: the rest of the app works
 * without it. Returns only these words, never details, because the health
 * route is public. Never starts the reader.
 */
export function checkHealth(db?: Db, dataDir?: string, now: number = Date.now(), reader: () => ReaderStatus = textReaderStatus): Health {
  let status: ReaderStatus;
  try {
    status = reader();
  } catch {
    status = "down";
  }
  try {
    (db ?? getDb()).run(sql`select 1`);
    return { ok: canWrite(path.resolve(dataDir ?? env().DATA_DIR), now), reader: status };
  } catch {
    return { ok: false, reader: status };
  }
}

/** For tests only. */
export function resetHealthCache(): void {
  holder.__crdHealthWrite = undefined;
}
