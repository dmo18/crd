/** Plain words for what an Undo in Manage did. Pure, for the browser too. */
export type UndoDone = { restored: number; removed: number; skipped: number; kind: "delete" | "import" | "change" };

const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

export function undoLine(r: UndoDone): string {
  const parts: string[] = [];
  if (r.kind === "import") {
    if (r.removed > 0) parts.push(`Removed the ${items(r.removed)} the import added. ${r.removed === 1 ? "It is" : "They are"} in Recently deleted.`);
    if (r.restored > 0) parts.push(`Put back the old values of ${items(r.restored)}.`);
  } else if (r.kind === "delete") {
    parts.push(`Put back ${items(r.restored)} from Recently deleted.`);
  } else {
    parts.push(`Put back the old values of ${items(r.restored)}.`);
  }
  if (parts.length === 0) parts.push("Nothing needed undoing.");
  if (r.skipped > 0) parts.push(`Skipped ${r.skipped.toLocaleString("en-US")} (edited or removed since).`);
  return parts.join(" ");
}
