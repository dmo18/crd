import { z } from "zod";
import { CATALOG_FIELDS, FIELD_SOURCES, SPORTS, type CatalogField, type FieldSource, type Item } from "@/db/schema";

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

/** What the scanner first read, kept as it was for good (`items.firstSuggestion`). */
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
  /** 0 to 1, the scanner's own figure. */
  confidence: z.number().min(0).max(1).nullable(),
  /** Which reader made it, e.g. "free". */
  reader: z.string().max(40).nullable(),
  /** Time in milliseconds. */
  at: z.number().int(),
});
export type FirstSuggestion = z.infer<typeof firstSuggestionSchema>;

export function buildFirstSuggestion(values: FieldValues, meta: { confidence: number | null; reader: string | null; at: Date }): string {
  const fields: Record<string, unknown> = {};
  for (const f of CATALOG_FIELDS) if (isFilled(values[f])) fields[f] = values[f];
  return JSON.stringify({ v: 1, fields, confidence: meta.confidence, reader: meta.reader ? meta.reader.slice(0, 40) : null, at: meta.at.getTime() });
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
