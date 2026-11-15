"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { revalueItem } from "@/lib/valuation";
import { recordSnapshot } from "@/lib/valuation/snapshots";

export type RevalueState = { message: string | null; error: string | null };

const idSchema = z.coerce.number().int().positive();

/** Asks for a fresh estimate for one item and saves it. */
export async function revalueItemAction(_prev: RevalueState, formData: FormData): Promise<RevalueState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: null, error: "This item no longer exists." };
  const result = await revalueItem(id.data);
  if (!result.ok) return { message: null, error: result.error };
  try {
    recordSnapshot();
  } catch {
    // The chart can catch up later. The new value is already saved.
  }
  revalidatePath(`/items/${id.data}`);
  revalidatePath("/items");
  revalidatePath("/");
  return { message: "Estimate updated.", error: null };
}
