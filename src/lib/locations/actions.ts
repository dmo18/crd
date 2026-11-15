"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/guard";
import { createLocation, deleteLocation, renameLocation } from "./locations";

export type LocationFormState = { status: "idle" | "saved" | "error"; errors: Record<string, string>; savedAt?: number };

const idSchema = z.coerce.number().int().positive();

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

function revalidateAll() {
  revalidatePath("/locations");
  revalidatePath("/items");
  revalidatePath("/scan");
}

function fields(formData: FormData) {
  return { name: str(formData.get("name")), kind: str(formData.get("kind")), notes: str(formData.get("notes")) };
}

export async function createLocationAction(_prev: LocationFormState, formData: FormData): Promise<LocationFormState> {
  await requireOwner();
  const result = createLocation(fields(formData));
  if (!result.ok) return { status: "error", errors: result.errors };
  revalidateAll();
  return { status: "saved", errors: {}, savedAt: Date.now() };
}

export async function renameLocationAction(_prev: LocationFormState, formData: FormData): Promise<LocationFormState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", errors: { form: "That location no longer exists." } };
  const result = renameLocation(id.data, fields(formData));
  if (!result.ok) return { status: "error", errors: result.errors };
  revalidateAll();
  return { status: "saved", errors: {}, savedAt: Date.now() };
}

export async function deleteLocationAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return;
  deleteLocation(id.data);
  revalidateAll();
}
