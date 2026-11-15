"use server";

import { getDb } from "@/db";
import { claimAlert, NOT_CONFIGURED, sendAlert } from "@/lib/alerts";
import { isOwner } from "@/lib/auth/guard";
import { alertChannels, env } from "@/lib/env";

export type TestAlertState = { ok: boolean | null; message: string | null };

const NAMES = { telegram: "Telegram", discord: "Discord" } as const;

/** Owner only. Sends a test alert now and says plainly whether it worked. */
export async function sendTestAlertAction(): Promise<TestAlertState> {
  if (!(await isOwner())) return { ok: false, message: "Please sign in again." };
  if (alertChannels(env()).length === 0) return { ok: false, message: NOT_CONFIGURED };
  if (!claimAlert("test_alert", 10_000, getDb())) return { ok: false, message: "A test was just sent. Wait a few seconds and try again." };
  const result = await sendAlert({
    severity: "info",
    title: "Test alert",
    body: "If you can read this, Card Vault alerts work.",
  });
  if (!result.ok) return { ok: false, message: result.reason };
  return { ok: true, message: `Sent to ${result.sent.map((c) => NAMES[c]).join(" and ")}. Check your phone.` };
}
