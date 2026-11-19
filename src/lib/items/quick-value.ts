import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, valuations } from "@/db/schema";
import { parseDollars } from "@/lib/money";
import { liveItem } from "./live";

export type QuickValueResult = { ok: true } | { ok: false; error: string };

/** Saves the price the owner saw on a sold listing as this item's own value. */
export function setQuickValue(itemId: number, dollarsText: string, db: Db = getDb()): QuickValueResult {
  const cents = parseDollars(dollarsText);
  if (cents == null) return { ok: false, error: "Enter a dollar amount like 12.50" };
  const item = db.select({ id: items.id }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: "This item no longer exists." };
  db.transaction((tx) => {
    tx.update(items).set({ manualValueCents: cents, updatedAt: new Date() }).where(eq(items.id, itemId)).run();
    tx.insert(valuations).values({ itemId, source: "manual", valueCents: cents, basis: "Entered by you from sold listings" }).run();
  });
  return { ok: true };
}
