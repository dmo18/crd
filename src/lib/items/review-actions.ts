"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { deleteStored } from "@/lib/images/store";
import { mergeInto } from "./duplicates";
import { confirmItem, deleteItem } from "./update";

const idSchema = z.coerce.number().int().positive();

function refresh() {
  revalidatePath("/review");
  revalidatePath("/items");
}

export async function mergeDuplicateAction(formData: FormData): Promise<void> {
  await requireOwner();
  const source = idSchema.safeParse(formData.get("sourceId"));
  const target = idSchema.safeParse(formData.get("targetId"));
  if (!source.success || !target.success) return;
  const result = mergeInto(source.data, target.data);
  if (!result.ok) {
    refresh();
    return;
  }
  for (const file of result.files) {
    try { await deleteStored(file); } catch { /* a missing file must not block the merge */ }
  }
  refresh();
  redirect(`/items/${result.targetId}`);
}

export async function confirmFromReviewAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  confirmItem(id.data);
  refresh();
}

export async function deleteFromReviewAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  await deleteItem(id.data);
  refresh();
}
