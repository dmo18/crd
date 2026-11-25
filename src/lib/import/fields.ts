/**
 * The app fields a spreadsheet column can fill, and the first guess of which
 * column is which, from the header words. Pure (no database), so the import
 * screen can use it in the browser too.
 */

export const IMPORT_FIELDS = [
  "id", "kind", "sport", "year", "yearEnd", "brand", "setName", "cardNumber", "player", "team", "variation",
  "isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia",
  "serialNumber", "rarityTier", "condition", "conditionNotes", "grader", "grade", "certNumber",
  "productType", "packCount", "sealState", "estCount", "containerType", "description",
  "quantity", "location", "manualValue", "notes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** A column the owner chose not to bring in. */
export const SKIP = "skip" as const;
export type ColumnChoice = ImportField | typeof SKIP;

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  id: "ID (updates that item)",
  kind: "Kind (card, sealed, bulk)",
  sport: "Sport",
  year: "Year",
  yearEnd: "Last year (bulk lots)",
  brand: "Brand",
  setName: "Set",
  cardNumber: "Card number",
  player: "Player",
  team: "Team",
  variation: "Variation",
  isRookie: "Rookie (yes or no)",
  isError: "Error card (yes or no)",
  isParallel: "Parallel (yes or no)",
  isInsert: "Insert (yes or no)",
  isAutograph: "Autograph (yes or no)",
  isMemorabilia: "Memorabilia (yes or no)",
  serialNumber: "Serial number",
  rarityTier: "Rarity",
  condition: "Condition",
  conditionNotes: "Condition notes",
  grader: "Grader",
  grade: "Grade",
  certNumber: "Cert number",
  productType: "Product type (sealed)",
  packCount: "Pack count (sealed)",
  sealState: "Seal state (sealed)",
  estCount: "Estimated count (bulk lots)",
  containerType: "Container (bulk lots)",
  description: "Description",
  quantity: "Quantity",
  location: "Location",
  manualValue: "Your value (USD)",
  notes: "Notes",
};

/** Short names used in row problems, e.g. "Row 14: Year must be ...". */
export const IMPORT_FIELD_NAMES: Record<ImportField, string> = {
  ...IMPORT_FIELD_LABELS,
  id: "ID", kind: "Kind", yearEnd: "Last year", isRookie: "Rookie", isError: "Error card", isParallel: "Parallel",
  isInsert: "Insert", isAutograph: "Autograph", isMemorabilia: "Memorabilia", productType: "Product type",
  packCount: "Pack count", sealState: "Seal state", estCount: "Estimated count", containerType: "Container",
  manualValue: "Value",
};

/** Lowercase, spaces collapsed, outer punctuation such as "No." or "Year:" removed. */
export function headerKey(header: string): string {
  return header.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[_\s]+/g, " ").trim().replace(/^[^a-z0-9#]+|[^a-z0-9#)]+$/g, "").trim();
}

/** The app's own export headers (src/lib/export/csv.ts), exactly, then the common words. */
const EXACT: Record<string, ColumnChoice> = {
  // Export columns that are worked out by the app, or not the owner's to set: never brought back in.
  "status": SKIP, "title": SKIP, "value each (usd)": SKIP, "total value (usd)": SKIP, "estimate low (usd)": SKIP,
  "estimate high (usd)": SKIP, "value source": SKIP, "confidence": SKIP, "added (iso date)": SKIP,
  // Export columns.
  "id": "id", "kind": "kind", "sport": "sport", "year": "year", "year end": "yearEnd", "brand": "brand", "set": "setName",
  "card number": "cardNumber", "player": "player", "team": "team", "variation": "variation", "rookie": "isRookie",
  "error": "isError", "parallel": "isParallel", "insert": "isInsert", "autograph": "isAutograph",
  "memorabilia": "isMemorabilia", "serial number": "serialNumber", "rarity": "rarityTier", "condition": "condition",
  "grader": "grader", "grade": "grade", "cert number": "certNumber", "product type": "productType",
  "pack count": "packCount", "seal state": "sealState", "estimated count": "estCount", "quantity": "quantity",
  "location": "location", "your value (usd)": "manualValue", "notes": "notes", "description": "description",
  // Common words in other spreadsheets.
  "name": "player", "player name": "player", "athlete": "player",
  "season": "year", "yr": "year",
  "manufacturer": "brand", "maker": "brand", "mfr": "brand", "company": "brand",
  "set name": "setName", "series": "setName", "product": "setName",
  "card #": "cardNumber", "card#": "cardNumber", "#": "cardNumber", "number": "cardNumber", "no": "cardNumber",
  "card no": "cardNumber", "num": "cardNumber", "card num": "cardNumber",
  "team name": "team",
  "qty": "quantity", "count": "quantity", "copies": "quantity",
  "cond": "condition",
  "grading company": "grader", "graded by": "grader",
  "cert": "certNumber", "cert #": "certNumber", "cert#": "certNumber", "certification": "certNumber", "cert no": "certNumber",
  "serial": "serialNumber", "serial #": "serialNumber", "numbered": "serialNumber", "print run": "serialNumber",
  "rc": "isRookie", "rookie card": "isRookie",
  "auto": "isAutograph", "signed": "isAutograph", "autographed": "isAutograph",
  "relic": "isMemorabilia", "patch": "isMemorabilia", "memorabilia card": "isMemorabilia",
  "value": "manualValue", "price": "manualValue", "worth": "manualValue", "market value": "manualValue",
  "value (usd)": "manualValue", "price (usd)": "manualValue", "my value": "manualValue",
  "box": "location", "binder": "location", "storage": "location", "where": "location",
  "note": "notes", "comments": "notes", "comment": "notes", "remarks": "notes",
  "variant": "variation", "parallel name": "variation",
  "type": "kind",
};

/** Words that stand for a price paid. They fill "Your value" only when no value or price column exists. */
const PAID = new Set(["paid", "price paid", "cost", "purchase price", "paid (usd)"]);

/** One header on its own: its field, "skip" for app-made export columns, or null for no idea. */
export function guessOne(header: string): ColumnChoice | null {
  const k = headerKey(header);
  if (k === "") return null;
  if (k in EXACT) return EXACT[k];
  // A few safe "contains" rules for headers such as "Player Full Name" or "Card Year".
  if (/\bplayer\b/.test(k)) return "player";
  if (/\byear\b/.test(k) && !/\bend\b|\blast\b/.test(k)) return "year";
  if (/\bnotes?\b/.test(k)) return "notes";
  if (/\bteam\b/.test(k)) return "team";
  if (/\bbrand\b/.test(k)) return "brand";
  return null;
}

/**
 * The first guess for every column of a file. Each app field is used once at
 * most (the first column that fits wins); the rest are "Do not import".
 */
export function guessMapping(header: string[]): ColumnChoice[] {
  const used = new Set<ImportField>();
  const out: ColumnChoice[] = header.map((h) => {
    const g = guessOne(h);
    if (g === null || g === SKIP || used.has(g)) return SKIP;
    used.add(g);
    return g;
  });
  if (!used.has("manualValue")) {
    const i = header.findIndex((h, idx) => out[idx] === SKIP && PAID.has(headerKey(h)));
    if (i >= 0) out[i] = "manualValue";
  }
  return out;
}
