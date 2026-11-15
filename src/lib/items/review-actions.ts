"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { getDb } from "@/db";
import { mergeInto } from "./duplicates";
import { deleteFailedScans, deletePhotoFiles } from "./remove";
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
  refresh();
  if (!result.ok) redirect(`/review?merge=${result.problem}`);
  await deletePhotoFiles(result.files);
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

/** Owner only: removes every failed scan and its photos. */
export async function deleteFailedScansAction(): Promise<void> {
  await requireOwner();
  const removed = await deleteFailedScans(getDb());
  refresh();
  redirect(`/review?cleared=${removed}`);
}
