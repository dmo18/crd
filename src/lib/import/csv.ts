/**
 * Reads CSV text (RFC 4180) into rows of cells. Pure: no database, no file
 * system, safe to use in the browser too. Nothing in a cell is ever run or
 * worked out: "=SUM(A1)" is just the text "=SUM(A1)".
 *
 * Handles: quoted cells, doubled quotes inside them, commas and line breaks
 * inside quotes, CRLF, LF and lone CR line ends, a byte order mark at the
 * start, and empty lines at the end.
 */

/** Largest file read, in bytes (UTF-8). */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** Most rows read, not counting the header row. */
export const MAX_CSV_ROWS = 20_000;
/** Most columns in one file. */
export const MAX_CSV_COLUMNS = 200;

export const CSV_MESSAGES = {
  tooBig: "This file is larger than 5 MB. Split it into smaller files and bring them in one at a time.",
  tooManyRows: `This file has more than ${MAX_CSV_ROWS.toLocaleString("en-US")} rows. Split it into smaller files and bring them in one at a time.`,
  tooManyColumns: `This file has more than ${MAX_CSV_COLUMNS} columns. Remove the columns you do not need and try again.`,
  empty: "This file is empty. Pick the file again, or paste the text.",
  noRows: "This file has a header row but no cards under it.",
  openQuote: "This file has a quote mark that is never closed, so it cannot be read safely. Save it again as CSV and try again.",
  notCsv: "This does not look like a CSV file. Save your spreadsheet as CSV first.",
} as const;

export type CsvResult = { ok: true; header: string[]; rows: string[][] } | { ok: false; error: string };

/** UTF-8 size of a text, without making a copy of it. */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i += 1; }
    else n += 3;
  }
  return n;
}

const blank = (r: string[]) => r.every((c) => c.trim() === "");

/**
 * Splits CSV text into records, leaving out empty ones. Returns null when a
 * quoted cell is never closed. Stops early (with `more: true`) once more than
 * `maxRecords` records are read.
 */
function records(text: string, maxRecords: number): { rows: string[][]; more: boolean } | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  /** True until the current cell has any character (or an opening quote). */
  let atStart = true;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(cell);
    // Empty rows are dropped here, so a file of blank lines never fills memory.
    if (!blank(row)) rows.push(row);
    row = [];
    cell = "";
  };
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && atStart) {
      // A quote opens quoting only as the first character of a cell. Elsewhere (5" tall) it is plain text, as spreadsheets read it.
      quoted = true;
      atStart = false;
      i += 1;
      continue;
    }
    if (ch === ",") { row.push(cell); cell = ""; atStart = true; i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      endRow();
      atStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      if (rows.length > maxRecords) return { rows, more: true };
      continue;
    }
    cell += ch;
    atStart = false;
    i += 1;
  }
  if (quoted) return null;
  // The last line, unless the text ended with a line break.
  if (!atStart || row.length > 0) endRow();
  return { rows, more: false };
}

/**
 * Reads the whole file. The first non-empty row is the header. Empty rows are
 * dropped (so empty trailing lines do not count). Every row is padded or cut
 * to the header's width.
 */
export function parseCsv(input: string): CsvResult {
  if (utf8Bytes(input) > MAX_CSV_BYTES) return { ok: false, error: CSV_MESSAGES.tooBig };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === "") return { ok: false, error: CSV_MESSAGES.empty };
  if (text.includes("\u0000")) return { ok: false, error: CSV_MESSAGES.notCsv };
  // The header plus one row more than allowed is enough to know it is too many.
  const read = records(text, MAX_CSV_ROWS + 1);
  if (!read) return { ok: false, error: CSV_MESSAGES.openQuote };
  const all = read.rows;
  if (all.length === 0) return { ok: false, error: CSV_MESSAGES.empty };
  const header = all[0].map((h) => h.trim());
  const body = all.slice(1);
  if (read.more || body.length > MAX_CSV_ROWS) return { ok: false, error: CSV_MESSAGES.tooManyRows };
  if (header.length > MAX_CSV_COLUMNS || body.some((r) => r.length > MAX_CSV_COLUMNS)) return { ok: false, error: CSV_MESSAGES.tooManyColumns };
  if (body.length === 0) return { ok: false, error: CSV_MESSAGES.noRows };
  const width = header.length;
  const rows = body.map((r) => (r.length === width ? r : r.length > width ? r.slice(0, width) : [...r, ...Array(width - r.length).fill("")]));
  return { ok: true, header, rows };
}

/**
 * Undoes the export's formula guard (src/lib/export/csv.ts adds one leading
 * apostrophe before =, +, - or @), so an exported file comes back exactly as
 * it was. Only that exact case is changed; the cell stays plain text.
 */
export function unguardCell(value: string): string {
  return value.startsWith("'") && /^'*[\s]*[=+\-@]|^'*[\t\r\n]/.test(value.slice(1)) ? value.slice(1) : value;
}
