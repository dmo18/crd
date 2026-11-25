"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { requireOwner } from "@/lib/auth/guard";
import { errorKind, log } from "@/lib/log";
import { purgeItems, restoreItems } from "./bin";
import { fillGuidePrices } from "@/lib/valuation/guide/apply";
import {
  applyBulk, binIds, MAX_BULK_IDS, parseAction, parseSelection, previewBulk, undoBulk, type BulkPreview,
} from "./bulk";

type Fail = { error: string };
const FAILED: Fail = { error: "Something went wrong. Nothing was changed. Try again." };

const requestSchema = z.object({ selection: z.unknown(), action: z.unknown() });
const opIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idsSchema = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(1, "Select at least one item first.")
  .max(MAX_BULK_IDS, `Pick up to ${MAX_BULK_IDS} items at a time.`);

const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

function revalidateAll() {
  try {
    // Bulk edits, undo and restore can change many items: bring their guide prices up to date.
    fillGuidePrices();
  } catch (err) {
    log.warn("guide_fill_failed", { error: errorKind(err) });
  }
  for (const p of ["/", "/items", "/review", "/scans", "/manage", "/manage/deleted"]) revalidatePath(p);
}

function readRequest(input: unknown) {
  const r = requestSchema.safeParse(input);
  if (!r.success) return { error: "That change could not be read. Try again." } as Fail;
  const selection = parseSelection(r.data.selection);
  if ("error" in selection) return selection;
  const action = parseAction(r.data.action);
  if ("error" in action) return action;
  return { selection, action };
}

/** Step one: how many items would change, with a few before and after samples. Changes nothing. */
export async function previewBulkAction(input: unknown): Promise<BulkPreview | Fail> {
  await requireOwner();
  const req = readRequest(input);
  if ("error" in req) return req;
  try {
    return previewBulk(req.selection, req.action);
  } catch (err) {
    log.error("bulk_preview_failed", { error: errorKind(err) });
    return { error: "Something went wrong. Try again." };
  }
}

/** Step two: makes the change to every selected item in one go, or to none. */
export async function applyBulkAction(input: unknown): Promise<{ changed: number; opId: number; summary: string } | Fail> {
  await requireOwner();
  const req = readRequest(input);
  if ("error" in req) return req;
  let result: Awaited<ReturnType<typeof applyBulk>>;
  try {
    result = applyBulk(req.selection, req.action);
  } catch (err) {
    log.error("bulk_apply_failed", { error: errorKind(err) });
    return FAILED;
  }
  if ("error" in result) return result;
  await auditThisRequest(req.action.type === "delete" ? "bulk_delete" : "bulk_edit", "ok", result.summary);
  revalidateAll();
  return result;
}

/** Undoes the latest bulk change, for items not edited since. */
export async function undoBulkAction(opId: unknown): Promise<{ restored: number; skipped: number } | Fail> {
  await requireOwner();
  const id = opIdSchema.safeParse(opId);
  if (!id.success) return { error: "This change can no longer be undone." };
  let result: Awaited<ReturnType<typeof undoBulk>>;
  try {
    result = undoBulk(id.data);
  } catch (err) {
    log.error("bulk_undo_failed", { error: errorKind(err) });
    return FAILED;
  }
  if ("error" in result) return result;
  await auditThisRequest("bulk_undo", "ok", `${result.summary}. ${items(result.restored)} put back, ${result.skipped} skipped`);
  revalidateAll();
  return { restored: result.restored, skipped: result.skipped };
}

/** Recently deleted: puts the chosen items back in the collection. */
export async function restoreItemsAction(ids: unknown): Promise<{ restored: number } | Fail> {
  await requireOwner();
  const r = idsSchema.safeParse(ids);
  if (!r.success) return { error: r.error.issues[0]?.message ?? "Select the items again." };
  let restored: number;
  try {
    restored = restoreItems(r.data);
  } catch (err) {
    log.error("bulk_restore_failed", { error: errorKind(err) });
    return FAILED;
  }
  if (restored > 0) await auditThisRequest("bulk_restore", "ok", items(restored));
  revalidateAll();
  return { restored };
}

/** Recently deleted: removes the chosen items for good, with their photos. */
export async function purgeItemsAction(ids: unknown): Promise<{ removed: number } | Fail> {
  await requireOwner();
  const r = idsSchema.safeParse(ids);
  if (!r.success) return { error: r.error.issues[0]?.message ?? "Select the items again." };
  return purge(r.data);
}

/** Recently deleted: removes everything in the bin for good. */
export async function emptyBinAction(): Promise<{ removed: number } | Fail> {
  await requireOwner();
  return purge(binIds(), "emptied the bin, ");
}

async function purge(ids: number[], prefix = ""): Promise<{ removed: number } | Fail> {
  let removed: number;
  try {
    removed = await purgeItems(ids);
  } catch (err) {
    log.error("bin_purge_failed", { error: errorKind(err) });
    return FAILED;
  }
  if (removed > 0) await auditThisRequest("bulk_purge", "ok", `${prefix}${items(removed)}`);
  revalidateAll();
  return { removed };
}
