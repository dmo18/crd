import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { bulkOps, items, type Item } from "@/db/schema";
import { fieldsToCheck, parseFieldSources } from "@/lib/catalog/sources";
import { MAX_BULK_IDS, pruneOps } from "./bulk";
import { liveItem } from "./live";
import { groupingFactsFor, reviewGroupOf } from "./review-groups";

type Fail = { error: string };
export type ReviewConfirmResult = { changed: number; skipped: number; opId: number; summary: string; ids: number[] };

const cards = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

/**
 * "Confirm selected" on the Review screen: every chosen item still waiting
 * in Review and in the "Ready to confirm" group (worked out again here, in
 * the same transaction) becomes confirmed; the others are skipped and counted with every value as it was read. Its "Check
 * this" marks are cleared (those fields now count as the owner's, who said
 * they are right); items not chosen keep theirs. Like a Manage change, it is
 * one entry in bulk_ops, so one Undo puts all of it back (status, marks and
 * catalog list), for items not edited since.
 */
export function confirmFromReview(ids: readonly number[], db: Db = getDb(), now: Date = new Date()): ReviewConfirmResult | Fail {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { error: "Select at least one item first." };
  if (unique.length > MAX_BULK_IDS) return { error: `Pick up to ${MAX_BULK_IDS} items at a time.` };
  return db.transaction((tx): ReviewConfirmResult | Fail => {
    const waiting: Item[] = tx.select().from(items)
      .where(and(inArray(items.id, unique), liveItem, eq(items.status, "needs_review"))).all();
    if (waiting.length === 0) return { error: "These are no longer waiting in Review." };
    const rows = waiting.filter((r) => reviewGroupOf(r, groupingFactsFor(r, tx as unknown as Db, now)).group === "ready");
    if (rows.length === 0) return { error: "None of these are ready to confirm. Open each one and check it first." };
    const undo: [number, Record<string, unknown>][] = [];
    for (const row of rows) {
      const patch: Partial<Item> = { status: "confirmed", updatedAt: now };
      const old: Record<string, unknown> = { status: row.status, updatedAt: row.updatedAt.getTime() };
      // Confirming ends the catalog question, as a single Confirm does; undo puts the list back.
      if (row.catalogCandidates != null && row.catalogCardId == null) {
        patch.catalogCandidates = null;
        old.catalogCandidates = row.catalogCandidates;
      }
      const toClear = row.kind === "card" ? fieldsToCheck(row) : [];
      if (toClear.length > 0) {
        const marks = parseFieldSources(row.fieldSources) ?? {};
        for (const f of toClear) marks[f] = "owner";
        patch.fieldSources = JSON.stringify(marks);
        old.fieldSources = row.fieldSources;
      }
      const res = tx.update(items).set(patch).where(and(eq(items.id, row.id), liveItem)).run();
      if (res.changes !== 1) throw new Error("review row changed during confirm");
      undo.push([row.id, old]);
    }
    const summary = `Confirmed ${cards(rows.length)} from Review`;
    const op = tx.insert(bulkOps).values({
      at: now, action: "status", summary, itemCount: rows.length, undo: JSON.stringify({ v: 1, from: "review", items: undo }),
    }).returning({ id: bulkOps.id }).get();
    pruneOps(tx as unknown as Db, now);
    return { changed: rows.length, skipped: unique.length - rows.length, opId: op.id, summary, ids: rows.map((r) => r.id) };
  }, { behavior: "immediate" });
}
