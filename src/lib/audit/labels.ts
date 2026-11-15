import type { AuditEvent, AuditOutcome } from "@/db/schema";

/** Plain words for where a visit came from. */
export function fromWhere(ip: string): string {
  return ip && ip !== "unknown" ? `from ${ip}` : "from an unknown address";
}

/** One line in plain language, like "Wrong password from 203.0.113.7". */
export function describeAudit(row: { event: AuditEvent; ip: string; detail: string | null }): string {
  const from = fromWhere(row.ip);
  const d = row.detail;
  switch (row.event) {
    case "sign_in_ok":
      return d === "new device" ? `Signed in on a new device ${from}` : `Signed in ${from}`;
    case "sign_in_failed":
      return d === "no password yet" ? `Sign-in tried before setup was finished ${from}` : `Wrong password ${from}`;
    case "sign_in_blocked":
      return d === "everyone"
        ? `Sign-in paused for everyone after many wrong passwords. Last try ${from}`
        : `Too many tries ${from}. Sign-in was paused for a while`;
    case "setup_done":
      return `Password set during first setup ${from}`;
    case "setup_failed":
      return `Wrong setup code ${from}`;
    case "password_changed":
      return `Password changed ${from}`;
    case "signed_out":
      return `Signed out ${from}`;
    case "signed_out_others":
      return `Signed out all other devices ${from}`;
    case "export_csv":
      return `Spreadsheet downloaded ${from}`;
    case "item_deleted":
      return d ? `Deleted ${d}` : "Deleted an item";
    case "failed_scans_deleted":
      return d ? `Deleted failed scans (${d})` : "Deleted failed scans";
    case "items_merged":
      return d ? `Merged duplicates: ${d}` : "Merged duplicates";
    case "location_deleted":
      return d ? `Deleted location ${d}` : "Deleted a location";
    case "backup_note":
      return d ? `Backup: ${d}` : "Backup note";
  }
}

export function outcomeTone(outcome: AuditOutcome): "neutral" | "warn" | "danger" {
  return outcome === "failed" ? "danger" : outcome === "blocked" ? "warn" : "neutral";
}

export function outcomeLabel(outcome: AuditOutcome): string {
  return outcome === "failed" ? "Failed" : outcome === "blocked" ? "Blocked" : "OK";
}
