"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { claimAlert } from "@/lib/alerts";
import { auditThisRequest } from "@/lib/audit/request";
import { isOwner } from "@/lib/auth/guard";
import { clearCache } from "./cache";
import { outsideCall } from "./gate";
import { recordKeyTest, removeKey, saveKey } from "./keys";
import { isSourceId, SOURCES, type SourceId } from "./sources";
import { setSourceEnabled } from "./usage";

/**
 * Actions of More, Connections. Every one checks the owner session first and
 * validates the form with zod. No answer, audit row or log line ever holds a
 * key or its last 4 characters: messages are fixed plain words.
 */

export type ConnectionActionState = { ok: boolean | null; message: string | null };

const SIGN_IN_AGAIN: ConnectionActionState = { ok: false, message: "Please sign in again." };
const NOT_VALID: ConnectionActionState = { ok: false, message: "That did not work. Reload the page and try again." };
/** Test may be tapped once per 10 seconds per source. */
const TEST_EVERY_MS = 10_000;
const PAGE = "/more/connections";

const sourceField = z.string().max(40).refine(isSourceId).transform((v) => v as SourceId);

const sourceForm = z.object({ source: sourceField });
const keyForm = z.object({ source: sourceField, key: z.string().max(1000) });
const switchForm = z.object({ source: sourceField, on: z.enum(["1", "0"]) });

/** Only text fields; files and anything unexpected are dropped, unknown names ignored. */
function readForm<S extends z.ZodType>(formData: unknown, schema: S): z.infer<S> | null {
  if (!(formData instanceof FormData)) return null;
  const raw: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !Object.hasOwn(raw, k)) raw[k] = v;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Saves (or replaces) the key of a source. The key is never sent back. */
export async function saveKeyAction(_prev: ConnectionActionState, formData: FormData): Promise<ConnectionActionState> {
  if (!(await isOwner())) return SIGN_IN_AGAIN;
  const form = readForm(formData, keyForm);
  if (!form || !SOURCES[form.source].needsKey) return NOT_VALID;
  const name = SOURCES[form.source].name;
  const saved = saveKey(getDb(), form.source, form.key);
  if (!saved.ok) {
    await auditThisRequest("connection_key_saved", "failed", `${name}: the key was not accepted`);
    return { ok: false, message: saved.message };
  }
  await auditThisRequest("connection_key_saved", "ok", name);
  revalidatePath(PAGE);
  return { ok: true, message: "Key saved. Tap Test to check it." };
}

export async function removeKeyAction(_prev: ConnectionActionState, formData: FormData): Promise<ConnectionActionState> {
  if (!(await isOwner())) return SIGN_IN_AGAIN;
  const form = readForm(formData, sourceForm);
  if (!form || !SOURCES[form.source].needsKey) return NOT_VALID;
  const had = removeKey(getDb(), form.source);
  await auditThisRequest("connection_key_removed", "ok", SOURCES[form.source].name);
  revalidatePath(PAGE);
  return { ok: true, message: had ? "Key removed." : "There was no key to remove." };
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** One small real call through the gate, in the `now` line. Counts as a call. */
export async function testConnectionAction(_prev: ConnectionActionState, formData: FormData): Promise<ConnectionActionState> {
  if (!(await isOwner())) return SIGN_IN_AGAIN;
  const form = readForm(formData, sourceForm);
  if (!form) return NOT_VALID;
  const src = SOURCES[form.source];
  const db = getDb();
  if (!claimAlert(`connection_test:${form.source}`, TEST_EVERY_MS, db)) {
    return { ok: false, message: "A test just ran. Wait a few seconds and try again." };
  }
  const result = await outsideCall(form.source, src.testCall, { line: "now", db });
  if (src.needsKey && (result.ok || result.reason !== "needs_key")) recordKeyTest(db, form.source, result.ok);
  await auditThisRequest("connection_tested", result.ok ? "ok" : "failed", result.ok ? `${src.name}: works` : `${src.name}: ${result.message}`);
  revalidatePath(PAGE);
  if (result.ok) return { ok: true, message: `Works, answered in ${seconds(result.ms)}.` };
  if (result.reason === "needs_key" && src.needsKey) return { ok: false, message: "Save a key first, or enter it again." };
  return { ok: false, message: result.message };
}

/** The owner's switch: off means no call at all to this source. */
export async function switchSourceAction(_prev: ConnectionActionState, formData: FormData): Promise<ConnectionActionState> {
  if (!(await isOwner())) return SIGN_IN_AGAIN;
  const form = readForm(formData, switchForm);
  if (!form) return NOT_VALID;
  const on = form.on === "1";
  setSourceEnabled(getDb(), form.source, on);
  await auditThisRequest("connection_switched", "ok", `${SOURCES[form.source].name} ${on ? "on" : "off"}`);
  revalidatePath(PAGE);
  return { ok: true, message: on ? "Switched on." : "Switched off. The app makes no calls to it now." };
}

/** Empties the stored answers of one source. */
export async function clearAnswersAction(_prev: ConnectionActionState, formData: FormData): Promise<ConnectionActionState> {
  if (!(await isOwner())) return SIGN_IN_AGAIN;
  const form = readForm(formData, sourceForm);
  if (!form) return NOT_VALID;
  const n = clearCache(getDb(), form.source);
  const words = n === 1 ? "1 stored answer" : `${n.toLocaleString("en-US")} stored answers`;
  await auditThisRequest("catalog_answers_cleared", "ok", `${SOURCES[form.source].name}, ${words}`);
  revalidatePath(PAGE);
  return { ok: true, message: n === 0 ? "Nothing was stored." : `Cleared ${words}.` };
}
