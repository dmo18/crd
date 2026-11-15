"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { getDb } from "@/db";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
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
  const label = `${itemLabel(source.data)} into ${itemLabel(target.data)}`;
  const result = mergeInto(source.data, target.data);
  refresh();
  if (!result.ok) redirect(`/review?merge=${result.problem}`);
  await auditThisRequest("items_merged", "ok", label);
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
  const label = itemLabel(id.data);
  const result = await deleteItem(id.data);
  if (result.ok) await auditThisRequest("item_deleted", "ok", label);
  refresh();
}

/** Owner only: removes every failed scan and its photos. */
export async function deleteFailedScansAction(): Promise<void> {
  await requireOwner();
  const removed = await deleteFailedScans(getDb());
  if (removed > 0) await auditThisRequest("failed_scans_deleted", "ok", `${removed} ${removed === 1 ? "scan" : "scans"}`);
  refresh();
  redirect(`/review?cleared=${removed}`);
}
