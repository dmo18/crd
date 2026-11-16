import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, valuations } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { env, recognitionMode } from "@/lib/env";
import { errorKind, log } from "@/lib/log";
import { AiPriceSource } from "./ai-source";
import { SampleSource } from "./sample-source";
import { ValuationError, type PriceQuote, type PriceSource } from "./types";

export const REVALUE_MESSAGES = {
  missing: "This item no longer exists.",
  noValue: "The AI could not put a value on this one.",
  freeMode: "Automatic estimates are off. Tap a sold listings link and enter the price you see.",
  notSetUp: "AI estimates are not set up yet. Add the API key in settings.",
  generic: "Something went wrong getting a value. Try again.",
} as const;

/** The price source to use right now, following the same setting as recognition. */
export function getPriceSource(): PriceSource {
  const mode = recognitionMode();
  if (mode === "sample") return new SampleSource();
  if (mode === "free") throw new ValuationError(REVALUE_MESSAGES.freeMode);
  if (!env().ANTHROPIC_API_KEY) throw new ValuationError(REVALUE_MESSAGES.notSetUp);
  return new AiPriceSource();
}

export type RevalueResult = { ok: true; quote: PriceQuote } | { ok: false; error: string };
export type RevalueDeps = { db?: Db; source?: PriceSource; now?: Date };

/**
 * Gets a fresh estimate for one item and saves it with a history row.
 * The owner's own value (manualValueCents) is never touched.
 * Never throws: failures come back as a plain message.
 */
export async function revalueItem(itemId: number, deps: RevalueDeps = {}): Promise<RevalueResult> {
  const db = deps.db ?? getDb();
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item) return { ok: false, error: REVALUE_MESSAGES.missing };

  let quote: PriceQuote | null;
  try {
    const source = deps.source ?? getPriceSource();
    quote = await source.quote(item);
  } catch (err) {
    // Log the kind of failure only, never item text or keys.
    log.error("valuation_failed", { itemId, error: errorKind(err) });
    return { ok: false, error: err instanceof ValuationError ? err.userMessage : REVALUE_MESSAGES.generic };
  }
  if (!quote) return { ok: false, error: REVALUE_MESSAGES.noValue };

  const at = deps.now ?? new Date();
  const saved = quote;
  const updated = db.transaction((tx) => {
    const row = tx.update(items).set({
      estLowCents: saved.lowCents,
      estHighCents: saved.highCents,
      estValueCents: saved.valueCents,
      valueSource: saved.source,
      valueBasis: saved.basis,
      valuedAt: at,
      updatedAt: at,
    }).where(and(eq(items.id, itemId), liveItem)).returning({ id: items.id }).get();
    if (!row) return false;
    tx.insert(valuations).values({
      itemId, source: saved.source, lowCents: saved.lowCents, highCents: saved.highCents,
      valueCents: saved.valueCents, basis: saved.basis, createdAt: at,
    }).run();
    return true;
  });
  // The item can be deleted (or moved to Recently deleted) while the AI is answering.
  if (!updated) return { ok: false, error: REVALUE_MESSAGES.missing };
  return { ok: true, quote };
}
