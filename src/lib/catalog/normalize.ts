/**
 * Text keys used to compare card facts that are spelled in different ways.
 * Used by the key card list (src/lib/free/key-cards.ts) and the catalog key.
 */

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Case and punctuation insensitive brand key: "O-Pee-Chee" and "o pee chee" both give "opeechee". */
export function normalizeBrand(s: string): string {
  return stripAccents(String(s ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Lowercase, accents stripped, punctuation removed: "Ken Griffey Jr." gives "ken griffey jr". */
export function normalizeName(s: string): string {
  return stripAccents(String(s ?? ""))
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Card number key: "U-27", "u27" and "27U" all match, leading zeros ignored. */
export function normalizeCardNumber(s: string): string {
  const up = String(s ?? "").toUpperCase();
  const letters = up.replace(/[^A-Z]/g, "");
  const digits = up.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
  return letters + digits;
}

/** Plain text key: lowercase, accents and punctuation removed, spaces collapsed. */
export function normalizeText(s: string): string {
  return stripAccents(String(s ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
