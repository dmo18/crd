import { z } from "zod";
import { getDb, type Db } from "@/db";
import { parseDollars } from "@/lib/money";
import { applyBulk, parseAction, realDay, type BulkAction } from "./bulk";

/**
 * Marks one item sold or removed, or puts it back in the collection. It goes
 * through the same code as Manage records, so it gets the same undo entry.
 * Input comes from a form: every value is text.
 */
const text = (max: number) => z.string().trim().max(max);
export const outcomeSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(["sold", "removed", "back"]),
  /** Dollars, like "12.50". Empty means not recorded. */
  price: text(20).default(""),
  /** A day, like 2026-11-25. Empty means not recorded. */
  date: text(10).default(""),
});

export type OutcomeResult = { ok: true; summary: string } | { ok: false; error: string };

export function setOutcome(input: unknown, db: Db = getDb(), now: Date = new Date()): OutcomeResult {
  const r = outcomeSchema.safeParse(input);
  if (!r.success) return { ok: false, error: "That could not be read. Try again." };
  const { id, outcome, price, date } = r.data;
  let action: BulkAction;
  if (outcome === "sold") {
    const cents = price === "" ? null : parseDollars(price);
    if (price !== "" && cents == null) return { ok: false, error: "Type the price in dollars, like 12.50." };
    if (date !== "" && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && realDay(date))) return { ok: false, error: "That date is not real. Pick the day again." };
    // The same check as Manage records: a real day, a price that is not too big.
    const parsed = parseAction({ type: "outcome", outcome: "sold", soldPriceCents: cents, soldDate: date === "" ? null : date });
    if ("error" in parsed) return { ok: false, error: parsed.error };
    action = parsed;
  } else {
    action = { type: "outcome", outcome };
  }
  const res = applyBulk({ ids: [id] }, action, db, now);
  if ("error" in res) {
    return { ok: false, error: res.error !== "Nothing here needs this change." ? res.error
      : outcome === "back" ? "This item is already in your collection." : "This item is not in your collection any more. It may be sold, removed or deleted." };
  }
  return { ok: true, summary: res.summary };
}
