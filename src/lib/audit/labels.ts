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
    case "item_restored":
      return d ? `Brought back ${d} from Recently deleted` : "Brought back an item from Recently deleted";
    case "bulk_edit":
      return d ? `Changed many at once: ${d}` : "Changed many items at once";
    case "bulk_delete":
      return d ? `Deleted many at once: ${d}` : "Deleted many items at once";
    case "bulk_restore":
      return d ? `Brought back from Recently deleted: ${d}` : "Brought back items from Recently deleted";
    case "bulk_purge":
      return d ? `Deleted forever: ${d}` : "Deleted items forever";
    case "bulk_undo":
      return d ? `Undid a change to many items: ${d}` : "Undid a change to many items";
    case "connection_key_saved":
      return d ? `Saved a key for a connection: ${d}` : "Saved a key for a connection";
    case "connection_key_removed":
      return d ? `Removed the key of a connection: ${d}` : "Removed the key of a connection";
    case "connection_tested":
      return d ? `Tested a connection: ${d}` : "Tested a connection";
    case "connection_switched":
      return d ? `Switched a connection on or off: ${d}` : "Switched a connection on or off";
    case "catalog_answers_cleared":
      return d ? `Cleared stored catalog answers: ${d}` : "Cleared stored catalog answers";
    case "catalog_card_added":
      return d ? `Added a card from the catalog: ${d}` : "Added a card from the catalog";
    case "catalog_card_linked":
      return d ? `Linked an item to a catalog card: ${d}` : "Linked an item to a catalog card";
    case "catalog_card_unlinked":
      return d ? `Unlinked an item from its catalog card: ${d}` : "Unlinked an item from its catalog card";
    case "catalog_none_of_these":
      return d ? `Said none of the catalog cards fit: ${d}` : "Said none of the catalog cards fit";
    case "catalog_lookup_again":
      return d ? `Looked a card up again in the catalog: ${d}` : "Looked a card up again in the catalog";
    case "version_chosen":
      return d ? `Chose the version of a card: ${d}` : "Chose the version of a card";
    case "serial_confirmed":
      return d ? `Confirmed a serial number: ${d}` : "Confirmed a serial number";
    case "rookie_set":
      return d ? `Set the rookie mark: ${d}` : "Set the rookie mark";
    case "photo_added":
      return d ? `Added a photo: ${d}` : "Added a photo";
    case "photo_edited":
      return d ? `Turned or trimmed a photo: ${d}` : "Turned or trimmed a photo";
    case "photo_restored":
      return d ? `Put back the original photo: ${d}` : "Put back the original photo";
    case "duplicate_kept_apart":
      return d ? `Kept two records apart: ${d}` : "Kept two records apart";
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
