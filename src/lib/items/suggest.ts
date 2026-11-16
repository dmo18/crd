import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { items } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { rookieStateSchema, withRookie } from "@/lib/items/rookie";
import { parseSuggestion, serialColumns, serialPartsSchema, SERIAL_MESSAGES } from "@/lib/items/serial";
import type { RookieState } from "@/db/schema";

/**
 * The owner's answers to the two questions a scan asks: "Is this the serial
 * number?" and "Rookie card?". Nothing else writes these answers. A scan only
 * keeps what it read (`serialSuggested`, a note); the owner's tap writes it.
 */

export const NOTHING_TO_ANSWER = "There is nothing to answer here any more.";
export const WEAK_NO_YES = "That read is not sure enough to accept as it is. Use Fix it or No serial number.";
export const ITEM_GONE = "This item no longer exists.";

export type SerialAnswer =
  | { kind: "yes" }
  | { kind: "fix"; copy: string; edition: string }
  | { kind: "no" };
export type AnswerResult = { ok: true; detail: string } | { ok: false; error: string };

const fixSchema = z.object({ copy: z.string().max(20), edition: z.string().max(20) });

/** "Yes" writes the suggestion the server stored (never fields from the browser), "Fix it" the two boxes, "No" only clears it. */
export function answerSerial(id: number, answer: SerialAnswer, db: Db = getDb()): AnswerResult {
  const row = db.select().from(items).where(and(eq(items.id, id), liveItem)).get();
  if (!row || row.kind !== "card") return { ok: false, error: ITEM_GONE };
  const suggestion = parseSuggestion(row.serialSuggested);
  if (!suggestion) return { ok: false, error: NOTHING_TO_ANSWER };
  const now = new Date();
  if (answer.kind === "no") {
    db.update(items).set({ serialSuggested: null, updatedAt: now }).where(and(eq(items.id, id), liveItem)).run();
    return { ok: true, detail: `item ${id}, no serial number` };
  }
  let columns;
  if (answer.kind === "yes") {
    if (suggestion.weak) return { ok: false, error: WEAK_NO_YES };
    columns = serialColumns({ copy: suggestion.copy, edition: suggestion.edition });
  } else {
    const typed = fixSchema.safeParse({ copy: answer.copy, edition: answer.edition });
    if (!typed.success) return { ok: false, error: SERIAL_MESSAGES.text };
    const parts = serialPartsSchema.safeParse({ serialCopy: typed.data.copy, serialEdition: typed.data.edition });
    if (!parts.success) return { ok: false, error: parts.error.issues[0]?.message ?? SERIAL_MESSAGES.text };
    if (parts.data === null) return { ok: false, error: SERIAL_MESSAGES.editionMissing };
    columns = serialColumns(parts.data);
  }
  // Only the serial columns and the cleared suggestion change: no field mark, no title, no other column.
  db.update(items).set({ ...columns, serialSuggested: null, updatedAt: now }).where(and(eq(items.id, id), liveItem)).run();
  return { ok: true, detail: `item ${id}, ${answer.kind === "yes" ? "accepted the read" : "typed by the owner"}` };
}

/** The owner's rookie answer: always source `owner`, through withRookie() so `isRookie` stays in step. */
export function answerRookie(id: number, state: unknown, db: Db = getDb()): AnswerResult {
  const parsed = rookieStateSchema.safeParse(state);
  if (!parsed.success) return { ok: false, error: "Pick Yes, No, Not sure or Disputed." };
  const row = db.select().from(items).where(and(eq(items.id, id), liveItem)).get();
  if (!row || row.kind !== "card") return { ok: false, error: ITEM_GONE };
  const answer: RookieState = parsed.data;
  db.update(items).set({ ...withRookie(answer, "owner"), updatedAt: new Date() }).where(and(eq(items.id, id), liveItem)).run();
  return { ok: true, detail: `item ${id}, ${answer}` };
}
