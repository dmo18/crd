"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { requireOwner } from "@/lib/auth/guard";
import { restoreItems } from "./bin";
import { createItem } from "./create";
import { confirmItem, deleteItem, updateItem } from "./update";

export type SaveState = { status: "idle" | "saved" | "error"; errors: Record<string, string>; savedAt?: number };

const idSchema = z.coerce.number().int().positive();
const FLAGS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"] as const;
const TEXT_FIELDS = [
  "sport", "year", "yearEnd", "brand", "setName", "cardNumber", "player", "team", "variation", "serialNumber",
  "rarityTier", "condition", "conditionNotes", "grader", "grade", "certNumber", "productType", "packCount",
  "sealState", "estCount", "containerType", "description", "quantity", "notes", "manualValue", "locationId",
] as const;

/** The two serial boxes and the four way rookie answer, sent only by the form that has them. */
const NEW_FIELDS = ["serialCopy", "serialEdition", "rookieState"] as const;

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

function revalidateItem(id: number) {
  revalidatePath(`/items/${id}`);
  revalidatePath("/items");
  revalidatePath("/");
}

export async function saveItemAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", errors: { form: "This item no longer exists." } };
  const input: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) input[key] = str(formData.get(key));
  for (const key of FLAGS) input[key] = formData.get(key) === "on";
  for (const key of NEW_FIELDS) if (formData.has(key)) input[key] = str(formData.get(key));
  const result = updateItem(id.data, input);
  if (!result.ok) return { status: "error", errors: result.errors };
  revalidateItem(id.data);
  return { status: "saved", errors: {}, savedAt: Date.now() };
}

/** Add by hand: saves a new item from the form and opens its page. No outside call. */
export async function createItemAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  await requireOwner();
  const input: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) input[key] = str(formData.get(key));
  for (const key of FLAGS) input[key] = formData.get(key) === "on";
  for (const key of NEW_FIELDS) if (formData.has(key)) input[key] = str(formData.get(key));
  const result = createItem(str(formData.get("kind")), input);
  if (!result.ok) return { status: "error", errors: result.errors };
  revalidateItem(result.id);
  redirect(`/items/${result.id}`);
}

export async function confirmItemAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  confirmItem(id.data);
  revalidateItem(id.data);
}

export async function deleteItemAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) redirect("/items");
  const title = itemLabel(id.data);
  const result = deleteItem(id.data);
  if (result.ok) await auditThisRequest("item_deleted", "ok", `${title}, to Recently deleted`);
  revalidateItem(id.data);
  redirect("/items");
}

/** Puts one item from Recently deleted back in the collection. */
export async function restoreItemAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) redirect("/items");
  const restored = restoreItems([id.data]);
  if (restored > 0) await auditThisRequest("item_restored", "ok", itemLabel(id.data));
  revalidateItem(id.data);
  revalidatePath("/review");
  revalidatePath("/scans");
  redirect(`/items/${id.data}`);
}
