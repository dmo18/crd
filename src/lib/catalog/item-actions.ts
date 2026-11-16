"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { requireOwner } from "@/lib/auth/guard";
import { unlinkCatalogCard } from "./apply";

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);

/** Unlink: sets the link to null and changes no other field. */
export async function unlinkCatalogAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) redirect("/items");
  const label = itemLabel(id.data);
  const r = unlinkCatalogCard(id.data, getDb());
  if (r.ok) await auditThisRequest("catalog_card_unlinked", "ok", label);
  revalidatePath(`/items/${id.data}`);
  redirect(`/items/${id.data}`);
}
