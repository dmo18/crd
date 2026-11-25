"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { recordSnapshot } from "@/lib/valuation/snapshots";
import { refreshGuidePrice } from "./apply";

export type GuideRefreshState = { message: string | null; error: string | null };

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);

/** "Refresh guide price" on the item page. No outside call. */
export async function refreshGuideAction(_prev: GuideRefreshState, formData: FormData): Promise<GuideRefreshState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: null, error: "This item no longer exists." };
  const r = refreshGuidePrice(id.data);
  if (!r.ok) return { message: null, error: r.error };
  try {
    recordSnapshot();
  } catch {
    // The chart catches up later; the guide price is saved.
  }
  revalidatePath(`/items/${id.data}`);
  revalidatePath("/items");
  revalidatePath("/");
  if (!r.price.ok) return { message: null, error: r.price.missing };
  return { message: r.changed ? "Guide price updated." : "Guide price is up to date.", error: null };
}
