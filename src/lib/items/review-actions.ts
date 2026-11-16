"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { getDb } from "@/db";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { MAX_STORED_CANDIDATES } from "@/lib/catalog/candidates";
import { dismissCandidates, lookUpAgain, NOT_ON_LIST, pickCandidate, takeCatalogValues } from "@/lib/catalog/pick";
import { mergeInto } from "./duplicates";
import { deleteFailedScans, deletePhotoFiles } from "./remove";
import { confirmItem, deleteItem } from "./update";

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);
/** The candidate is chosen by its place in the list the server stored, never by its fields. */
const positionSchema = z.coerce.number().int().min(0).max(MAX_STORED_CANDIDATES - 1);

export type CatalogActionState = { message: string | null };

function refresh() {
  revalidatePath("/review");
  revalidatePath("/items");
  revalidatePath("/scans");
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
  const result = deleteItem(id.data);
  if (result.ok) await auditThisRequest("item_deleted", "ok", `${label}, to Recently deleted`);
  refresh();
}

/** Owner only: removes every failed scan and its photos. */
const backSchema = z.enum(["review", "scans"]).catch("review");

export async function deleteFailedScansAction(formData?: FormData): Promise<void> {
  await requireOwner();
  const back = backSchema.parse(formData?.get("back"));
  const removed = await deleteFailedScans(getDb());
  if (removed > 0) await auditThisRequest("failed_scans_deleted", "ok", `${removed} ${removed === 1 ? "scan" : "scans"}`);
  refresh();
  redirect(`/${back}?cleared=${removed}`);
}

/** "This one": links the stored candidate at that place, fills empty fields, and confirms when nothing differs. */
export async function pickCandidateAction(_prev: CatalogActionState, formData: FormData): Promise<CatalogActionState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: "This item no longer exists." };
  const position = positionSchema.safeParse(formData.get("position"));
  if (!position.success) return { message: NOT_ON_LIST };
  const label = itemLabel(id.data);
  const r = pickCandidate(id.data, position.data);
  if (!r.ok) return { message: r.error };
  await auditThisRequest("catalog_card_linked", "ok", `${label} is ${r.line}`);
  refresh();
  revalidatePath(`/items/${id.data}`);
  return { message: r.confirmed ? null : "Linked. Some details differ, see below." };
}

/** "Use the catalog's values" in Review: replaces what the scanner read differently, then confirms. */
export async function catalogValuesAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  const r = takeCatalogValues(id.data, { confirm: true });
  if (r.ok && r.replaced.length > 0) {
    await auditThisRequest("catalog_card_linked", "ok", `${itemLabel(id.data)}, used the catalog's values`);
  }
  refresh();
  revalidatePath(`/items/${id.data}`);
}

/** "None of these": clears the list; the item stays in Review. */
export async function dismissCandidatesAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  dismissCandidates(id.data);
  refresh();
}

/** "Look up again" with the item's fields of the moment. Once per 10 seconds per item. */
export async function lookUpAgainAction(_prev: CatalogActionState, formData: FormData): Promise<CatalogActionState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: "This item no longer exists." };
  const r = await lookUpAgain(id.data);
  if (!r.ok) return { message: r.error };
  refresh();
  if (r.found > 0) return { message: r.found === 1 ? "Found 1 possible card." : `Found ${r.found} possible cards.` };
  if (r.notChecked) return { message: null };
  return { message: "Nothing found in the catalog. Check the year, brand and player, then try again." };
}
