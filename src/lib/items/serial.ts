import { z } from "zod";

/**
 * Serial numbers ("045/100") in two parts: the copy and the edition (print
 * run). Pure functions. The stored text `items.serialNumber` is what is shown
 * and exported; it is rebuilt by formatSerial() whenever the parts are saved.
 *
 * - Copy: 1 to 6 digits, leading zeros kept ("045"). Not 0, not above the
 *   edition. May be empty when it cannot be read ("/100").
 * - Edition: 1 to 6 digits, 1 to 999999, stored without leading zeros.
 * - A text that does not split ("1 of 1 promo") is never forced into parts.
 */

export const SERIAL_MAX_EDITION = 999_999;

export type SerialParts = { copy: string | null; edition: string };
/** `parts` null means no serial number at all (both empty). */
export type SerialResult = { ok: true; parts: SerialParts | null } | { ok: false; error: string };

const DIGITS = /^\d{1,6}$/;
/** "045/100", "045 / 100", "#045/100", "45 of 100", "/100". Nothing before or after. */
const SERIAL_TEXT = /^#?\s*(\d{1,6})?\s*(?:\/|\bof\b)\s*(\d{1,6})$/i;

export const SERIAL_MESSAGES = {
  copyDigits: "Use only digits for the copy, like 045.",
  editionDigits: "Use only digits for the print run, like 100.",
  editionMissing: "Enter the print run too (the number after \"of\").",
  editionRange: `The print run must be from 1 to ${SERIAL_MAX_EDITION.toLocaleString("en-US")}.`,
  copyZero: "The copy cannot be 0.",
  copyAbove: "The copy cannot be higher than the print run.",
  text: "Type the serial number like 045/100.",
} as const;

/** Checks the two boxes "Copy" and "of". Both empty means no serial number. */
export function checkSerialParts(copyInput: string | null | undefined, editionInput: string | null | undefined): SerialResult {
  const copy = (copyInput ?? "").trim();
  const edition = (editionInput ?? "").trim();
  if (copy === "" && edition === "") return { ok: true, parts: null };
  if (copy !== "" && !DIGITS.test(copy)) return { ok: false, error: SERIAL_MESSAGES.copyDigits };
  if (edition === "") return { ok: false, error: SERIAL_MESSAGES.editionMissing };
  if (!DIGITS.test(edition)) return { ok: false, error: SERIAL_MESSAGES.editionDigits };
  const runSize = Number(edition);
  if (runSize < 1 || runSize > SERIAL_MAX_EDITION) return { ok: false, error: SERIAL_MESSAGES.editionRange };
  if (copy !== "") {
    const n = Number(copy);
    if (n === 0) return { ok: false, error: SERIAL_MESSAGES.copyZero };
    if (n > runSize) return { ok: false, error: SERIAL_MESSAGES.copyAbove };
  }
  return { ok: true, parts: { copy: copy === "" ? null : copy, edition: String(runSize) } };
}

/** Reads a typed or stored serial text. Empty text is no serial number. */
export function parseSerial(text: string | null | undefined): SerialResult {
  const t = (text ?? "").trim();
  if (t === "") return { ok: true, parts: null };
  const m = SERIAL_TEXT.exec(t);
  if (!m) return { ok: false, error: SERIAL_MESSAGES.text };
  return checkSerialParts(m[1] ?? "", m[2]);
}

/**
 * The parts of an old stored text, for showing it in two boxes. Null when the
 * text does not split cleanly ("1 of 1 promo", "150/100"): it is then shown
 * whole and left untouched.
 */
export function splitSerial(text: string | null | undefined): SerialParts | null {
  const r = parseSerial(text);
  return r.ok ? r.parts : null;
}

/** The text shown and exported: "045/100", or "/100" when only the edition is known. Null without an edition. */
export function formatSerial(copy: string | null | undefined, edition: string | null | undefined): string | null {
  const e = (edition ?? "").trim();
  if (e === "") return null;
  return `${(copy ?? "").trim()}/${e}`;
}

/** The two form boxes as zod checks them. Gives the parts, or null for no serial number. */
export const serialPartsSchema = z.object({
  serialCopy: z.string().max(20, SERIAL_MESSAGES.copyDigits),
  serialEdition: z.string().max(20, SERIAL_MESSAGES.editionDigits),
}).transform((v, ctx) => {
  const r = checkSerialParts(v.serialCopy, v.serialEdition);
  if (!r.ok) {
    const path = r.error === SERIAL_MESSAGES.copyDigits || r.error === SERIAL_MESSAGES.copyZero || r.error === SERIAL_MESSAGES.copyAbove
      ? "serialCopy" : "serialEdition";
    ctx.addIssue({ code: "custom", path: [path], message: r.error });
    return z.NEVER;
  }
  return r.parts;
});

/** The columns to write for a serial: the parts and the text rebuilt from them. */
export function serialColumns(parts: SerialParts | null): { serialCopy: string | null; serialEdition: string | null; serialNumber: string | null } {
  if (!parts) return { serialCopy: null, serialEdition: null, serialNumber: null };
  return { serialCopy: parts.copy, serialEdition: parts.edition, serialNumber: formatSerial(parts.copy, parts.edition) };
}

// ---------------------------------------------------------------------------
// What the reader read: only ever a suggestion (`items.serialSuggested`)

/** What `items.serialSuggested` holds: the read, the line it stood in, and whether it is weak. */
export type SerialSuggestion = { copy: string | null; edition: string; line: string; weak: boolean; why: string[] };

const suggestionSchema = z.object({
  copy: z.string().regex(DIGITS).nullable().catch(null),
  edition: z.string().regex(DIGITS),
  line: z.string().max(80).catch(""),
  weak: z.boolean().catch(true),
  why: z.array(z.string().max(120)).max(5).catch([]),
});

export const BEFORE_1990 = "Cards before 1990 were almost never numbered";

/**
 * The suggestion to store for a scan, or null for none. `read` is what the
 * reader saw (free reader) or only the text the paid reader answered. The
 * text must split cleanly and obey the serial rules, else nothing is stored.
 * A read from a card before 1990 is always weak.
 */
export function suggestionFromRead(
  read: { text: string; line?: string; weak?: boolean; why?: string[] } | null | undefined,
  year: number | null | undefined,
): SerialSuggestion | null {
  if (!read) return null;
  const why = [...(read.why ?? [])];
  let weak = read.weak ?? false;
  let parts: SerialParts | null = null;
  const r = parseSerial(read.text);
  if (r.ok && r.parts) parts = r.parts;
  else {
    // A copy above the edition is refused by parseSerial but is still worth showing as a weak read.
    const m = SERIAL_TEXT.exec(read.text.trim());
    if (!m || !m[1] || !DIGITS.test(m[2])) return null;
    if (Number(m[1]) !== 0 && Number(m[2]) >= 1 && Number(m[1]) > Number(m[2])) {
      parts = { copy: m[1], edition: String(Number(m[2])) };
      weak = true;
      if (!why.some((w) => w.includes("higher"))) why.push("the copy number is higher than the print run");
    } else return null;
  }
  if (!parts) return null;
  if (year != null && year < 1990) {
    weak = true;
    if (!why.includes(BEFORE_1990)) why.push(BEFORE_1990);
  }
  return { copy: parts.copy, edition: parts.edition, line: (read.line ?? read.text).slice(0, 80), weak, why };
}

/** Reads the stored suggestion back. Null when there is none or it cannot be read. */
export function parseSuggestion(raw: string | null | undefined): SerialSuggestion | null {
  if (!raw) return null;
  try {
    const r = suggestionSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** What the screen says: "045/100". */
export function suggestionText(s: Pick<SerialSuggestion, "copy" | "edition">): string {
  return formatSerial(s.copy, s.edition) ?? "";
}
