import type { Item } from "@/db/schema";
import { valueSourceLabel } from "@/lib/items/labels";
import { readRookie } from "@/lib/items/rookie";

type Cell = string | number | boolean | Date | null | undefined;
/** Text cells get the formula guard; money and counts the code formats itself do not. */
type Col = { header: string; get: (r: Item, locations: Map<number, string>) => { v: Cell; kind: "text" | "raw" } };

const text = (v: Cell) => ({ v, kind: "text" as const });
const raw = (v: Cell) => ({ v, kind: "raw" as const });
const yesNo = (b: boolean | null) => text(b == null ? "" : b ? "Yes" : "No");
/** Rookie is Yes or No only when it was answered or confirmed; "Not sure", "Disputed" and not recorded stay blank. */
const rookieCell = (r: Item) => {
  const { state } = readRookie(r);
  return yesNo(state === "yes" ? true : state === "no" ? false : null);
};
const dollars = (cents: number | null | undefined) => raw(cents == null ? "" : (cents / 100).toFixed(2));
const count = (n: number | null | undefined) => raw(n == null ? "" : String(n));

const unitCents = (r: Item) => r.manualValueCents ?? r.estValueCents ?? null;

const COLUMNS: Col[] = [
  { header: "ID", get: (r) => count(r.id) },
  { header: "Kind", get: (r) => text(r.kind) },
  { header: "Status", get: (r) => text(r.status) },
  { header: "Title", get: (r) => text(r.title) },
  { header: "Sport", get: (r) => text(r.sport) },
  { header: "Year", get: (r) => count(r.year) },
  { header: "Year end", get: (r) => count(r.yearEnd) },
  { header: "Brand", get: (r) => text(r.brand) },
  { header: "Set", get: (r) => text(r.setName) },
  { header: "Card number", get: (r) => text(r.cardNumber) },
  { header: "Player", get: (r) => text(r.player) },
  { header: "Team", get: (r) => text(r.team) },
  { header: "Variation", get: (r) => text(r.variation) },
  { header: "Rookie", get: (r) => rookieCell(r) },
  { header: "Error", get: (r) => yesNo(r.isError) },
  { header: "Parallel", get: (r) => yesNo(r.isParallel) },
  { header: "Insert", get: (r) => yesNo(r.isInsert) },
  { header: "Autograph", get: (r) => yesNo(r.isAutograph) },
  { header: "Memorabilia", get: (r) => yesNo(r.isMemorabilia) },
  { header: "Serial number", get: (r) => text(r.serialNumber) },
  { header: "Rarity", get: (r) => text(r.rarityTier) },
  { header: "Condition", get: (r) => text(r.condition) },
  { header: "Grader", get: (r) => text(r.grader) },
  { header: "Grade", get: (r) => text(r.grade) },
  { header: "Cert number", get: (r) => text(r.certNumber) },
  { header: "Product type", get: (r) => text(r.productType) },
  { header: "Pack count", get: (r) => count(r.packCount) },
  { header: "Seal state", get: (r) => text(r.sealState) },
  { header: "Estimated count", get: (r) => count(r.estCount) },
  { header: "Quantity", get: (r) => count(r.quantity) },
  { header: "Location", get: (r, l) => text(r.locationId == null ? "" : (l.get(r.locationId) ?? "")) },
  { header: "Value each (USD)", get: (r) => dollars(unitCents(r)) },
  { header: "Total value (USD)", get: (r) => dollars(unitCents(r) == null ? null : unitCents(r)! * r.quantity) },
  { header: "Estimate low (USD)", get: (r) => dollars(r.estLowCents) },
  { header: "Estimate high (USD)", get: (r) => dollars(r.estHighCents) },
  { header: "Value source", get: (r) => text(valueSourceLabel(r.manualValueCents, r.valueSource)) },
  { header: "Your value (USD)", get: (r) => dollars(r.manualValueCents) },
  { header: "Confidence", get: (r) => raw(r.confidence == null ? "" : String(Math.round(r.confidence * 100) / 100)) },
  { header: "Notes", get: (r) => text(r.notes) },
  { header: "Added (ISO date)", get: (r) => raw(r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "") },
  { header: "Sold price (USD)", get: (r) => dollars(r.soldPriceCents) },
  { header: "Sold date", get: (r) => raw(r.soldAt ? new Date(r.soldAt).toISOString().slice(0, 10) : "") },
  // Last on purpose: the long free text sits at the end of each line.
  { header: "Description", get: (r) => text(r.description) },
];

/** Stops spreadsheets from running a cell as a formula. */
export function guardFormula(value: string): string {
  // Leading spaces and line breaks are skipped by some spreadsheets, so look past them too.
  // Text that already starts with apostrophes before a trigger gets one more, so the import
  // (src/lib/import/csv.ts unguardCell) can take exactly one off and get the same text back.
  return /^'*[\s]*[=+\-@]|^'*[\t\r\n]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 quoting. */
export function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellText(c: ReturnType<Col["get"]>): string {
  const s = c.v == null ? "" : String(c.v);
  return quoteField(c.kind === "text" ? guardFormula(s) : s);
}

/** A whole collection as CSV text: BOM, CRLF line endings, header row first. */
export function itemsToCsv(rows: Item[], locationNames: Map<number, string>): string {
  const lines = [COLUMNS.map((c) => quoteField(c.header)).join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => cellText(c.get(r, locationNames))).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
