import { z } from "zod";
import { getDb, type Db } from "@/db";
import { items, locations, valuations, ITEM_KINDS, type Item, type NewItem } from "@/db/schema";
import { eq } from "drizzle-orm";
import { sourcesFor } from "@/lib/catalog/sources";
import { buildTitle } from "@/lib/title";
import { editableFields, itemEditSchema, ownerSerialAndRookie, type ItemEditInput } from "./update";

/**
 * Add by hand. Only one of player, set name or description is needed; every
 * other field may stay empty. Saved as `confirmed`, every filled catalog
 * field marked `owner`, and no outside call is made.
 */

const kindSchema = z.enum(ITEM_KINDS);
const FLAG_KEYS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"];

export type CreateResult = { ok: true; id: number } | { ok: false; errors: Record<string, string> };

export const NEEDS_ONE = "Fill in at least a player, a set or a description so you can find this again.";

export function createItem(kindInput: unknown, input: unknown, db: Db = getDb()): CreateResult {
  const kind = kindSchema.safeParse(kindInput);
  if (!kind.success) return { ok: false, errors: { form: "Pick card, sealed or bulk." } };
  const raw: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of Object.keys(itemEditSchema.shape)) {
    if (raw[key] == null) raw[key] = FLAG_KEYS.includes(key) ? false : "";
  }
  if (raw.quantity === "") raw.quantity = "1";
  const parsed = itemEditSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!errors[key]) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  const { manualValue, locationId, ...rest } = parsed.data;
  const allowed = new Set(editableFields(kind.data));
  const values: Record<string, unknown> = {};
  for (const key of allowed) values[key] = (rest as Record<string, unknown>)[key];
  const has = (k: string) => typeof values[k] === "string" && (values[k] as string).trim() !== "";
  if (!has("player") && !has("setName") && !has("description")) return { ok: false, errors: { form: NEEDS_ONE } };
  if (kind.data === "card") {
    // Serial parts and the rookie mark in step with the old columns; a ticked rookie box is the owner's own answer.
    const extras = ownerSerialAndRookie(null, rest, raw);
    if (!extras.ok) return extras;
    delete values.isRookie;
    Object.assign(values, extras.patch);
  }
  if (locationId !== null && !db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).get()) {
    return { ok: false, errors: { locationId: "That location no longer exists." } };
  }
  const now = new Date();
  const row: NewItem = {
    ...(values as Partial<NewItem>),
    kind: kind.data,
    status: "confirmed",
    title: buildTitle({ kind: kind.data, ...(values as Partial<Item>) }),
    fieldSources: sourcesFor(values, "owner"),
    locationId,
    manualValueCents: manualValue,
    createdAt: now,
    updatedAt: now,
  };
  if (kind.data === "sealed") { row.productType ??= "other"; row.sealState ??= "unknown"; }
  const id = db.transaction((tx) => {
    const made = tx.insert(items).values(row).returning({ id: items.id }).get();
    if (manualValue !== null) {
      tx.insert(valuations).values({
        itemId: made.id, source: "manual", lowCents: null, highCents: null, valueCents: manualValue,
        basis: "Value entered by you.", createdAt: now,
      }).run();
    }
    return made.id;
  });
  return { ok: true, id };
}
export type { ItemEditInput };
