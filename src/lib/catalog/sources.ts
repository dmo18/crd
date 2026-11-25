import { z } from "zod";
import { CATALOG_FIELDS, FIELD_SOURCES, SPORTS, type CatalogField, type FieldSource, type Item } from "@/db/schema";
import { HOLD_REASONS } from "@/lib/recognition/types";

/**
 * Where the value of each catalog field of an item came from, stored as JSON
 * in `items.fieldSources`. The safe reading everywhere: a filled field with
 * no mark (old items have none at all) counts as the owner's, so it is never
 * overwritten.
 */
export type FieldSources = Partial<Record<CatalogField, FieldSource>>;
type FieldValues = Partial<Record<CatalogField, unknown>>;

const fieldSourcesSchema = z.partialRecord(z.enum(CATALOG_FIELDS), z.enum(FIELD_SOURCES).optional().catch(undefined));

export function isFilled(v: unknown): boolean {
  return !(v == null || (typeof v === "string" && v.trim() === ""));
}

/** Reads the stored marks. Null when there are none or they cannot be read (then every filled field is the owner's). */
export function parseFieldSources(raw: string | null | undefined): FieldSources | null {
  if (!raw) return null;
  try {
    const r = fieldSourcesSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    const out: FieldSources = {};
    for (const f of CATALOG_FIELDS) if (r.data[f]) out[f] = r.data[f];
    return out;
  } catch {
    return null;
  }
}

/** The source of one field: null when the field is empty, `owner` when it is filled and not marked. */
export function sourceOf(item: Pick<Item, CatalogField | "fieldSources">, field: CatalogField, parsed?: FieldSources | null): FieldSource | null {
  if (!isFilled(item[field])) return null;
  const marks = parsed === undefined ? parseFieldSources(item.fieldSources) : parsed;
  return marks?.[field] ?? "owner";
}

/** Marks for a new item: every filled catalog field gets the same source. */
export function sourcesFor(values: FieldValues, source: FieldSource): string {
  const out: FieldSources = {};
  for (const f of CATALOG_FIELDS) if (isFilled(values[f])) out[f] = source;
  return JSON.stringify(out);
}

/**
 * The marks after the owner changed some fields (item form or bulk change):
 * every catalog field whose value changed becomes `owner`, a field that was
 * emptied loses its mark. Returns undefined when nothing needs to be written,
 * which is always the case for items without marks (already all `owner`).
 */
export function markOwnerChanges(existing: Pick<Item, CatalogField | "fieldSources">, patch: FieldValues): string | undefined {
  const marks = parseFieldSources(existing.fieldSources);
  if (!marks) return undefined;
  let changed = false;
  for (const f of CATALOG_FIELDS) {
    if (!(f in patch) || patch[f] === existing[f]) continue;
    if (isFilled(patch[f])) {
      if (marks[f] !== "owner") { marks[f] = "owner"; changed = true; }
    } else if (marks[f]) {
      delete marks[f];
      changed = true;
    }
  }
  return changed ? JSON.stringify(marks) : undefined;
}

/** What the reader first read, kept as it was for good (`items.firstSuggestion`). */
export const firstSuggestionSchema = z.object({
  v: z.literal(1),
  fields: z.object({
    sport: z.enum(SPORTS).optional(),
    year: z.number().int().optional(),
    brand: z.string().max(200).optional(),
    setName: z.string().max(200).optional(),
    cardNumber: z.string().max(200).optional(),
    player: z.string().max(200).optional(),
    team: z.string().max(200).optional(),
    variation: z.string().max(200).optional(),
  }),
  /** 0 to 1, the reader's own figure. */
  confidence: z.number().min(0).max(1).nullable(),
  /** Which reader made it, e.g. "free". */
  reader: z.string().max(40).nullable(),
  /**
   * Fields the reader filled without being sure (12R.5 round 2): shown to the
   * owner as "Check this" while the value is still the one read. Kept here
   * so no new column is needed; old suggestions have none.
   */
  unsure: z.array(z.enum(CATALOG_FIELDS)).max(CATALOG_FIELDS.length).optional().catch(undefined),
  /** Why the card must wait for the owner whatever the catalog says (ReadEvidence.hold). */
  hold: z.array(z.enum(HOLD_REASONS)).max(HOLD_REASONS.length).optional().catch(undefined),
  /** Filled fields the reader did not read on the card (key card list, Wikidata). */
  notRead: z.array(z.enum(CATALOG_FIELDS)).max(CATALOG_FIELDS.length).optional().catch(undefined),
  /** Time in milliseconds. */
  at: z.number().int(),
});
export type FirstSuggestion = z.infer<typeof firstSuggestionSchema>;

export function buildFirstSuggestion(
  values: FieldValues,
  meta: {
    confidence: number | null; reader: string | null; at: Date; unsure?: readonly CatalogField[];
    hold?: readonly (typeof HOLD_REASONS)[number][]; notRead?: readonly CatalogField[];
  },
): string {
  const fields: Record<string, unknown> = {};
  for (const f of CATALOG_FIELDS) if (isFilled(values[f])) fields[f] = values[f];
  const unsure = CATALOG_FIELDS.filter((f) => isFilled(values[f]) && meta.unsure?.includes(f));
  const notRead = CATALOG_FIELDS.filter((f) => isFilled(values[f]) && meta.notRead?.includes(f));
  const hold = HOLD_REASONS.filter((h) => meta.hold?.includes(h));
  return JSON.stringify({
    v: 1, fields, confidence: meta.confidence, reader: meta.reader ? meta.reader.slice(0, 40) : null, at: meta.at.getTime(),
    ...(unsure.length > 0 ? { unsure } : {}),
    ...(hold.length > 0 ? { hold } : {}),
    ...(notRead.length > 0 ? { notRead } : {}),
  });
}

/**
 * The fields to mark "Check this" for the owner: the reader was not sure of
 * them, and they still hold the value it read (not changed by the owner or
 * filled from the catalog since).
 */
export function fieldsToCheck(item: Pick<Item, CatalogField | "fieldSources" | "firstSuggestion">): CatalogField[] {
  const first = parseFirstSuggestion(item.firstSuggestion);
  const marks = parseFieldSources(item.fieldSources);
  // A blank filled from the catalog's set list is always checked by the owner.
  const fromList = CATALOG_FIELDS.filter((f) => sourceOf(item, f, marks) === "checklist");
  const unsure = (first?.unsure ?? []).filter((f) => sourceOf(item, f, marks) === "reading" && String(item[f]) === String(first!.fields[f]));
  return CATALOG_FIELDS.filter((f) => unsure.includes(f) || fromList.includes(f));
}

/**
 * The filled fields whose value was NOT read from the card nor given by the
 * owner: filled from the catalog, its set list, the key card list or
 * Wikidata, or a `reading` value that is not what the reader read (an older
 * unlink relabelled catalog values `reading`). A verified match never rests
 * on these (S1a rule C).
 */
export function notReadFields(item: Pick<Item, CatalogField | "fieldSources" | "firstSuggestion">): CatalogField[] {
  const first = parseFirstSuggestion(item.firstSuggestion);
  const marks = parseFieldSources(item.fieldSources);
  return CATALOG_FIELDS.filter((f) => {
    const source = sourceOf(item, f, marks);
    if (source === null || source === "owner") return false;
    if (source !== "reading") return true;
    if (!first) return false;
    if (first.notRead?.includes(f)) return true;
    return first.fields[f] === undefined || String(first.fields[f]) !== String(item[f]);
  });
}

/** Reads a stored first suggestion. Null when there is none (items from before the catalog) or it cannot be read. */
export function parseFirstSuggestion(raw: string | null | undefined): FirstSuggestion | null {
  if (!raw) return null;
  try {
    const r = firstSuggestionSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
