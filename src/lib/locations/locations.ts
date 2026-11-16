import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { items, locations } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { LOCATION_KINDS } from "./kinds";


export const locationInputSchema = z.object({
  name: z.string().trim().min(1, "Give this location a name.").max(60, "Keep the name under 60 characters."),
  kind: z.union([z.literal(""), z.enum(LOCATION_KINDS)], { error: "Pick one of the kinds in the list." })
    .transform((v) => (v === "" ? null : v)),
  notes: z.string().trim().max(300, "Keep notes under 300 characters.").transform((v) => (v === "" ? null : v)),
});

export type LocationInput = z.input<typeof locationInputSchema>;
export type LocationResult = { ok: true; id: number } | { ok: false; errors: Record<string, string> };

export type LocationSummary = {
  id: number;
  name: string;
  kind: string | null;
  notes: string | null;
  itemCount: number;
  unitCount: number;
  totalValueCents: number;
};

const DUPLICATE = "You already have a location with that name.";

export function listLocations(db: Db = getDb()): LocationSummary[] {
  return db
    .select({
      id: locations.id,
      name: locations.name,
      kind: locations.kind,
      notes: locations.notes,
      itemCount: sql<number>`count(${items.id})`.mapWith(Number),
      unitCount: sql<number>`coalesce(sum(${items.quantity}), 0)`.mapWith(Number),
      totalValueCents: sql<number>`coalesce(sum(coalesce(${items.manualValueCents}, ${items.estValueCents}, 0) * ${items.quantity}), 0)`.mapWith(Number),
    })
    .from(locations)
    .leftJoin(items, and(eq(items.locationId, locations.id), liveItem))
    .groupBy(locations.id)
    .orderBy(asc(sql`lower(${locations.name})`), asc(locations.id))
    .all();
}

function parse(input: unknown): { data: z.output<typeof locationInputSchema> } | { errors: Record<string, string> } {
  const raw = { ...(input as Record<string, unknown>) };
  for (const key of ["name", "kind", "notes"]) if (raw[key] == null) raw[key] = "";
  const parsed = locationInputSchema.safeParse(raw);
  if (parsed.success) return { data: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) errors[key] = issue.message;
  }
  return { errors };
}

function nameTaken(db: Db, name: string, exceptId?: number): boolean {
  const same = sql`lower(${locations.name}) = ${name.toLowerCase()}`;
  const where = exceptId == null ? same : and(same, ne(locations.id, exceptId));
  return db.select({ id: locations.id }).from(locations).where(where).get() !== undefined;
}

/** True for the database refusing a second location with the same name (any capitals). */
function isDuplicateName(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && (code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(err.message));
}

/**
 * Runs a write that may hit the unique name index. The early check above
 * gives the message in the normal case; this catches two saves that race.
 */
function guardDuplicate(write: () => LocationResult): LocationResult {
  try {
    return write();
  } catch (err) {
    if (isDuplicateName(err)) return { ok: false, errors: { name: DUPLICATE } };
    throw err;
  }
}

export function createLocation(input: unknown, db: Db = getDb()): LocationResult {
  const r = parse(input);
  if ("errors" in r) return { ok: false, errors: r.errors };
  if (nameTaken(db, r.data.name)) return { ok: false, errors: { name: DUPLICATE } };
  return guardDuplicate(() => ({ ok: true, id: db.insert(locations).values(r.data).returning({ id: locations.id }).get().id }));
}

export function renameLocation(id: number, input: unknown, db: Db = getDb()): LocationResult {
  const r = parse(input);
  if ("errors" in r) return { ok: false, errors: r.errors };
  const existing = db.select({ id: locations.id }).from(locations).where(eq(locations.id, id)).get();
  if (!existing) return { ok: false, errors: { form: "That location no longer exists." } };
  if (nameTaken(db, r.data.name, id)) return { ok: false, errors: { name: DUPLICATE } };
  return guardDuplicate(() => {
    db.update(locations).set(r.data).where(eq(locations.id, id)).run();
    return { ok: true, id };
  });
}

/** Items in the location are kept; the database sets their location to none. */
export function deleteLocation(id: number, db: Db = getDb()): { ok: boolean } {
  const res = db.delete(locations).where(eq(locations.id, id)).run();
  return { ok: res.changes > 0 };
}
