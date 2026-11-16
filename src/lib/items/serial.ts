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
