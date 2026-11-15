"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { recordSnapshot } from "@/lib/valuation/snapshots";
import { setQuickValue } from "./quick-value";

export type QuickValueState = { saved: boolean; error: string | null };

const idSchema = z.coerce.number().int().positive();

export async function quickValueAction(_prev: QuickValueState, formData: FormData): Promise<QuickValueState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { saved: false, error: "This item no longer exists." };
  const text = formData.get("price");
  const result = setQuickValue(id.data, typeof text === "string" ? text : "");
  if (!result.ok) return { saved: false, error: result.error };
  try {
    recordSnapshot();
  } catch {
    // The chart just misses today if this fails.
  }
  revalidatePath(`/items/${id.data}`);
  revalidatePath("/items");
  revalidatePath("/");
  return { saved: true, error: null };
}
