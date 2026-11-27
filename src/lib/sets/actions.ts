"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { cardSets, checklistEntries, wantedCards } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { SET_KEY_RE } from "./identity";
import { loadChecklist, type LoadResult } from "./checklist";
import { ownedCardsOf } from "./view";

const keySchema = z.string().trim().max(170).regex(SET_KEY_RE);
const numberSchema = z.string().trim().min(1).max(30).regex(/^[A-Z0-9-]+$/);
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

export type ChecklistState = { result: LoadResult | null; error: string | null };

/** "Get the checklist" and "Get it again": the one place a set's checklist is fetched. */
export async function getChecklistAction(_prev: ChecklistState, formData: FormData): Promise<ChecklistState> {
  await requireOwner();
  const key = keySchema.safeParse(str(formData.get("key")));
  if (!key.success) return { result: null, error: "This set could not be found." };
  const result = await loadChecklist(key.data);
  revalidatePath(`/sets/${key.data}`);
  revalidatePath("/sets");
  return { result, error: null };
}

/**
 * Want or stop wanting a missing card. A mark is only made for a number on the
 * stored checklist that the owner does not have; its number and player come
 * from the stored list, never from the browser.
 */
export async function toggleWantAction(formData: FormData): Promise<void> {
  await requireOwner();
  const key = keySchema.safeParse(str(formData.get("key")));
  const num = numberSchema.safeParse(str(formData.get("number")));
  const want = z.enum(["yes", "no"]).safeParse(str(formData.get("want")));
  if (!key.success || !num.success || !want.success) return;
  const db = getDb();
  const set = db.select().from(cardSets).where(eq(cardSets.key, key.data)).get();
  if (!set) return;
  if (want.data === "no") {
    db.delete(wantedCards).where(and(eq(wantedCards.setId, set.id), eq(wantedCards.numberKey, num.data))).run();
  } else {
    const entry = db.select().from(checklistEntries).where(and(eq(checklistEntries.setId, set.id), eq(checklistEntries.numberKey, num.data))).get();
    const owned = ownedCardsOf(key.data, db)?.cards.some((c) => c.numberKey === num.data) ?? false;
    if (entry && !owned) {
      db.insert(wantedCards).values({ setId: set.id, numberKey: num.data, cardNumber: entry.cardNumber, player: entry.player })
        .onConflictDoNothing().run();
    }
  }
  revalidatePath(`/sets/${key.data}`);
}
