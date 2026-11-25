"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { getDb } from "@/db";
import { auditThisRequest, requestContext } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { MAX_STORED_CANDIDATES } from "@/lib/catalog/candidates";
import { dismissCandidates, lookUpAgain, lookUpAgainLine, NOT_ON_LIST, pickCandidate, takeCatalogValues } from "@/lib/catalog/pick";
import { keepApart, mergeInto } from "./duplicates";
import { deleteFailedScans } from "./remove";
import { confirmItem, deleteItem } from "./update";
import { refreshGuideQuietly } from "@/lib/valuation/guide/apply";

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);
/** The candidate is chosen by its place in the list the server stored, never by its fields. */
const positionSchema = z.coerce.number().int().min(0).max(MAX_STORED_CANDIDATES - 1);

const sourceIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/);

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
  // The server decides again whether these two may be combined; the form only names them.
  const result = mergeInto(source.data, target.data);
  if (result.ok) refreshGuideQuietly(result.targetId);
  refresh();
  if (!result.ok) redirect(`/review?merge=${result.problem}`);
  const photos = result.movedPhotos === 0 ? "" : `, ${result.movedPhotos} ${result.movedPhotos === 1 ? "photo" : "photos"} moved`;
  await auditThisRequest("items_merged", "ok", `${label}${photos}`);
  revalidatePath(`/items/${result.targetId}`);
  redirect(`/items/${result.targetId}`);
}

/** "Keep both as they are": the pair is remembered on both records and not asked about again. */
export async function keepApartAction(formData: FormData): Promise<void> {
  await requireOwner();
  const item = idSchema.safeParse(formData.get("itemId"));
  const other = idSchema.safeParse(formData.get("otherId"));
  if (!item.success || !other.success) return;
  const label = `${itemLabel(item.data)} and ${itemLabel(other.data)}`;
  const result = keepApart(item.data, other.data);
  refresh();
  revalidatePath(`/items/${item.data}`);
  revalidatePath(`/items/${other.data}`);
  if (result.ok) await auditThisRequest("duplicate_kept_apart", "ok", label);
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
  const sourceId = sourceIdSchema.safeParse(formData.get("sourceId"));
  if (!sourceId.success) return { message: NOT_ON_LIST };
  const label = itemLabel(id.data);
  const r = pickCandidate(id.data, position.data, sourceId.data);
  refreshGuideQuietly(id.data);
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
  refreshGuideQuietly(id.data);
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
  const who = await requestContext();
  dismissCandidates(id.data, getDb(), who);
  refresh();
  revalidatePath(`/items/${id.data}`);
}

/** "Look up again" with the item's fields of the moment. Once per 10 seconds per item. */
export async function lookUpAgainAction(_prev: CatalogActionState, formData: FormData): Promise<CatalogActionState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: "This item no longer exists." };
  const r = await lookUpAgain(id.data, { who: await requestContext() });
  if (!r.ok) return { message: r.error };
  refresh();
  revalidatePath(`/items/${id.data}`);
  if (r.matched) await auditThisRequest("catalog_card_linked", "ok", `${itemLabel(id.data)} is ${r.matched}, matched by the app`);
  return { message: lookUpAgainLine(r) };
}
