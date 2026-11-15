import { and, desc, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/db";
import { scans } from "@/db/schema";
import { sendAlertOnce, type Alert, type AlertOnceDeps } from "@/lib/alerts";
import { fromWhere } from "./labels";
import { countAuditSince } from "./store";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Failed sign-ins (and wrong setup codes) from anywhere that start an alert. */
export const FAILED_SIGN_IN_ALERT_COUNT = 5;
export const FAILED_SIGN_IN_WINDOW_MS = 15 * MINUTE;
/** Failed scans in a row that start an alert. */
export const SCAN_FAILURE_STREAK = 3;

/** Each alert, its dedupe key and how long before it may repeat. */
export const ALERT_RULES = {
  manyFailed: { key: "many_failed_sign_ins", cooldownMs: HOUR },
  paused: { key: "sign_in_paused", cooldownMs: HOUR },
  newDevice: { key: "new_device", cooldownMs: MINUTE },
  passwordChanged: { key: "password_changed", cooldownMs: MINUTE },
  setupDone: { key: "setup_done", cooldownMs: MINUTE },
  scanStreak: { key: "scan_failure_streak", cooldownMs: HOUR },
} as const;

export type AlertRule = keyof typeof ALERT_RULES;

/** The alert for a rule, or null when the rule does not apply. */
export function manyFailedAlert(db: Db, now: Date = new Date()): Alert | null {
  const n = countAuditSince(["sign_in_failed", "setup_failed"], new Date(now.getTime() - FAILED_SIGN_IN_WINDOW_MS), db);
  if (n < FAILED_SIGN_IN_ALERT_COUNT) return null;
  return {
    severity: "warning",
    title: "Many wrong passwords",
    body: `${n} failed sign-ins in the last 15 minutes. If this was not you, someone may be guessing. Check More, Activity.`,
  };
}

export function pausedAlert(ip: string): Alert {
  return {
    severity: "critical",
    title: "Sign-in paused for everyone",
    body: `So many wrong passwords came in that sign-in is paused for up to 15 minutes. Phones that signed in here before can still get in. Last try ${fromWhere(ip)}.`,
  };
}

export function newDeviceAlert(ip: string): Alert {
  return {
    severity: "warning",
    title: "Signed in on a new device",
    body: `Someone signed in ${fromWhere(ip)} on a browser not seen before. If this was not you, change your password and sign out all other devices.`,
  };
}

export function passwordChangedAlert(ip: string): Alert {
  return {
    severity: "warning",
    title: "Password changed",
    body: `The password was changed ${fromWhere(ip)}. Every other device was signed out. If this was not you, act now.`,
  };
}

export function setupDoneAlert(ip: string): Alert {
  return { severity: "info", title: "Setup finished", body: `The owner password was set ${fromWhere(ip)}.` };
}

/** True when the last SCAN_FAILURE_STREAK finished scans all failed. */
export function scanFailureStreak(db: Db): boolean {
  const last = db.select({ status: scans.status }).from(scans)
    .where(and(inArray(scans.status, ["done", "failed"]), isNotNull(scans.finishedAt)))
    .orderBy(desc(scans.finishedAt), desc(scans.id))
    .limit(SCAN_FAILURE_STREAK).all();
  return last.length === SCAN_FAILURE_STREAK && last.every((s) => s.status === "failed");
}

/** Alerts when scans keep failing. Runs in the background scan queue. Never throws. */
export async function checkScanStreak(db: Db, deps: AlertOnceDeps = {}): Promise<void> {
  try {
    if (!scanFailureStreak(db)) return;
    const { key, cooldownMs } = ALERT_RULES.scanStreak;
    await sendAlertOnce(key, cooldownMs, {
      severity: "warning",
      title: "Scans keep failing",
      body: `The last ${SCAN_FAILURE_STREAK} scans failed. Card reading may be broken. Try one clear photo, and check the server if it fails again.`,
    }, { ...deps, db });
  } catch {
    // Alerts never break scanning.
  }
}
