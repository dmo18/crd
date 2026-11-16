"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { requireOwner } from "@/lib/auth/guard";
import { photoEditSchema } from "@/lib/images/edit";
import { editPhoto, restorePhoto } from "./photos";

export type PhotoState = { status: "idle" | "done" | "error"; message: string; at?: number };

const idSchema = z.coerce.number().int().positive();
const target = z.object({ itemId: idSchema, imageId: idSchema });

function refresh(itemId: number, imageId: number) {
  revalidatePath(`/items/${itemId}`);
  revalidatePath(`/items/${itemId}/photo/${imageId}`);
  revalidatePath("/items");
}

/** Turn left, turn right or trim. All numbers are checked here, whatever the page sent. */
export async function editPhotoAction(_prev: PhotoState, formData: FormData): Promise<PhotoState> {
  await requireOwner();
  const t = target.safeParse({ itemId: formData.get("itemId"), imageId: formData.get("imageId") });
  const kind = formData.get("kind");
  const edit = photoEditSchema.safeParse(
    kind === "turn"
      ? { kind, direction: formData.get("direction") }
      : { kind, top: num(formData, "top"), bottom: num(formData, "bottom"), left: num(formData, "left"), right: num(formData, "right") },
  );
  if (!t.success) return { status: "error", message: "That photo was not found." };
  if (!edit.success) return { status: "error", message: "Those numbers are not allowed. Use whole numbers from 0 to 40." };
  const label = itemLabel(t.data.itemId);
  const result = await editPhoto({ ...t.data, edit: edit.data });
  if (!result.ok) return { status: "error", message: result.error };
  await auditThisRequest("photo_edited", "ok", `${label}, ${edit.data.kind === "turn" ? `turned ${edit.data.direction}` : "trimmed"}`);
  refresh(t.data.itemId, t.data.imageId);
  return { status: "done", message: edit.data.kind === "turn" ? "Turned." : "Trimmed.", at: Date.now() };
}

export async function restorePhotoAction(_prev: PhotoState, formData: FormData): Promise<PhotoState> {
  await requireOwner();
  const t = target.safeParse({ itemId: formData.get("itemId"), imageId: formData.get("imageId") });
  if (!t.success) return { status: "error", message: "That photo was not found." };
  const label = itemLabel(t.data.itemId);
  const result = await restorePhoto(t.data);
  if (!result.ok) return { status: "error", message: result.error };
  await auditThisRequest("photo_restored", "ok", label);
  refresh(t.data.itemId, t.data.imageId);
  return { status: "done", message: "The original photo is back.", at: Date.now() };
}

/** A missing or blank number is passed on as NaN-free `undefined`, so zod refuses it; text is turned into a number only when it is whole digits. */
function num(formData: FormData, name: string): number | undefined {
  const v = formData.get(name);
  return typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : undefined;
}
