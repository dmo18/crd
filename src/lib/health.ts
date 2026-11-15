import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { env } from "@/lib/env";

/**
 * Is the app able to do its job? Checks that the database answers and that the
 * data folder can be written. Returns only a yes or no: never details, because
 * the health route is public.
 */
export function checkHealth(db?: Db, dataDir?: string): { ok: boolean } {
  try {
    (db ?? getDb()).run(sql`select 1`);
    const dir = path.resolve(dataDir ?? env().DATA_DIR);
    const probe = path.join(dir, `.health-${randomBytes(6).toString("hex")}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
