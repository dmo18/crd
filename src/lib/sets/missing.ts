import { tableToCsv } from "@/lib/export/csv";
import type { SetView } from "./view";

/** The missing cards of a set as plain text for the clipboard, wanted cards marked. */
export function missingText(view: SetView): string {
  const missing = view.rows.filter((r) => !r.owned);
  const lines = [`${view.label}: ${missing.length} missing ${missing.length === 1 ? "card" : "cards"}`];
  if (view.checklist?.present && !view.checklist.complete) lines.push("This checklist may be incomplete.");
  for (const r of missing) {
    const num = r.cardNumber ? `#${r.cardNumber}` : "#?";
    lines.push([num, r.player ?? "", r.wanted ? "(want)" : ""].filter(Boolean).join(" "));
  }
  return lines.join("\n");
}

/** Missing and wanted cards as CSV, through the shared writer with its formula guard. */
export function missingCsv(view: SetView): string {
  const rows = view.rows
    .filter((r) => !r.owned)
    .map((r) => [view.label, r.cardNumber ?? "", r.player ?? "", r.team ?? "", r.wanted ? "Yes" : "No", r.onList ? "Missing" : "Wanted"]);
  return tableToCsv(["Set", "Card number", "Player", "Team", "Wanted", "Status"], rows);
}
