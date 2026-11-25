import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { bulkOps } from "@/db/schema";

/**
 * Takes purged item ids out of every saved bulk undo entry, so their old text
 * does not linger. An operation left with no items is deleted. Call inside a
 * transaction.
 */
export function scrubUndo(tx: Db, removedIds: number[]): void {
  if (removedIds.length === 0) return;
  const gone = new Set(removedIds);
  for (const op of tx.select({ id: bulkOps.id, undo: bulkOps.undo }).from(bulkOps).all()) {
    let parsed: { items?: unknown; created?: unknown };
    try {
      parsed = JSON.parse(op.undo);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.items)) continue;
    const kept = parsed.items.filter((e) => !(Array.isArray(e) && gone.has(e[0] as number)));
    // An import also lists the items it added.
    const created = Array.isArray(parsed.created) ? parsed.created : null;
    const keptCreated = created?.filter((id) => !gone.has(id as number)) ?? null;
    if (kept.length === parsed.items.length && keptCreated?.length === created?.length) continue;
    if (kept.length === 0 && (keptCreated?.length ?? 0) === 0) tx.delete(bulkOps).where(eq(bulkOps.id, op.id)).run();
    else {
      const next = keptCreated ? { ...parsed, items: kept, created: keptCreated } : { ...parsed, items: kept };
      tx.update(bulkOps).set({ undo: JSON.stringify(next) }).where(eq(bulkOps.id, op.id)).run();
    }
  }
}
