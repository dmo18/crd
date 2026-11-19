"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { requireOwner } from "@/lib/auth/guard";
import { ITEM_GONE, answerRookie, answerSerial, type SerialAnswer } from "./suggest";

export type AskState = { message: string | null };

const idSchema = z.coerce.number().int().positive().max(2_000_000_000);
const answerSchema = z.enum(["yes", "fix", "no"]);

function refresh(id: number) {
  revalidatePath(`/items/${id}`);
  revalidatePath("/items");
  revalidatePath("/review");
}

/** "Is this the serial number?": Yes, Fix it (two boxes) or No serial number. */
export async function serialAnswerAction(_prev: AskState, formData: FormData): Promise<AskState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  const kind = answerSchema.safeParse(formData.get("answer"));
  if (!id.success || !kind.success) return { message: ITEM_GONE };
  const text = (k: string) => { const v = formData.get(k); return typeof v === "string" ? v : ""; };
  const answer: SerialAnswer = kind.data === "fix"
    ? { kind: "fix", copy: text("serialCopy"), edition: text("serialEdition") }
    : { kind: kind.data };
  const r = answerSerial(id.data, answer);
  if (!r.ok) return { message: r.error };
  await auditThisRequest("serial_confirmed", "ok", r.detail);
  refresh(id.data);
  return { message: null };
}

/** "Rookie card?": Yes, No, Not sure or Disputed. The answer is the owner's and no later step changes it. */
export async function rookieAnswerAction(_prev: AskState, formData: FormData): Promise<AskState> {
  await requireOwner();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: ITEM_GONE };
  const r = answerRookie(id.data, formData.get("answer"));
  if (!r.ok) return { message: r.error };
  await auditThisRequest("rookie_set", "ok", r.detail);
  refresh(id.data);
  return { message: null };
}
