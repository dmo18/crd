"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { confirmItem, deleteItem, updateItem } from "./update";

export type SaveState = { status: "idle" | "saved" | "error"; errors: Record<string, string>; savedAt?: number };

const idSchema = z.coerce.number().int().positive();
const FLAGS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"] as const;
const TEXT_FIELDS = [
  "sport", "year", "yearEnd", "brand", "setName", "cardNumber", "player", "team", "variation", "serialNumber",
  "rarityTier", "condition", "conditionNotes", "grader", "grade", "certNumber", "productType", "packCount",
  "sealState", "estCount", "containerType", "description", "quantity", "notes", "manualValue",
] as const;

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
  const result = updateItem(id.data, input);
  if (!result.ok) return { status: "error", errors: result.errors };
  revalidateItem(id.data);
  return { status: "saved", errors: {}, savedAt: Date.now() };
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
  await deleteItem(id.data);
  revalidateItem(id.data);
  redirect("/items");
}
