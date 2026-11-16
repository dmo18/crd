"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditThisRequest, requestContext } from "@/lib/audit/request";
import { requireOwner } from "@/lib/auth/guard";
import { ANOTHER_MAX, chooseVersion, GONE, LIST_CHANGED, loadVersionOptions, MAX_VERSION_OPTIONS } from "./versions";

/**
 * "Which version is it?" on the item page and in Review. "Show versions"
 * stores a list and chooses nothing; "Save" writes the option at the position
 * the owner tapped in that stored list. Both need the owner's session.
 */

export type VersionActionState = { message: string | null };

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);
/** The option is chosen by its place in the list the server stored, never by its fields. */
const positionSchema = z.coerce.number().int().min(0).max(MAX_VERSION_OPTIONS - 1);
/** The time of the stored list the owner looked at. */
const listAtSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Only "Another version" reads it; the length rule is checked again where it is written. */
const textSchema = z.string().max(ANOTHER_MAX * 2).optional();

function refresh(id: number) {
  revalidatePath(`/items/${id}`);
  revalidatePath("/items");
  revalidatePath("/review");
}

/** "Show versions": once per 10 seconds per item; at most 2 catalog calls, through the gate. */
export async function showVersionsAction(_prev: VersionActionState, formData: FormData): Promise<VersionActionState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: GONE };
  const ctx = await requestContext();
  const r = await loadVersionOptions(id.data, { who: { ip: ctx.ip, deviceId: ctx.deviceId } });
  if (!r.ok) return { message: r.error };
  refresh(id.data);
  return { message: null };
}

/** "Save" under the list: the owner's choice. Writes the audit row `version_chosen` (item id, state, source; no free text). */
export async function chooseVersionAction(_prev: VersionActionState, formData: FormData): Promise<VersionActionState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: GONE };
  const position = positionSchema.safeParse(formData.get("position"));
  const listAt = listAtSchema.safeParse(formData.get("listAt"));
  if (!position.success || !listAt.success) return { message: LIST_CHANGED };
  const rawText = formData.get("text");
  const text = textSchema.safeParse(typeof rawText === "string" ? rawText : undefined);
  if (!text.success) return { message: `Keep the name under ${ANOTHER_MAX} characters.` };
  const r = chooseVersion(id.data, { position: position.data, listAt: listAt.data, text: text.data ?? null });
  if (!r.ok) return { message: r.error };
  await auditThisRequest("version_chosen", "ok", `item ${id.data}, ${r.state === "not_sure" ? "not sure" : "confirmed"}${r.source ? `, ${r.source}` : ""}`);
  refresh(id.data);
  return { message: r.differences.length > 0 ? "Saved. Some details differ from the catalog, see below." : null };
}
