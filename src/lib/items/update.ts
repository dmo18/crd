import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { CONDITIONS, items, locations, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS, valuations, type Item } from "@/db/schema";
import { MAX_QUANTITY } from "@/lib/items/duplicates";
import { deletePhotoFiles, removeItemRows } from "@/lib/items/remove";
import { parseDollars } from "@/lib/money";
import { buildTitle } from "@/lib/title";

const text = (max: number) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`).transform((v) => (v === "" ? null : v));
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.literal(""), z.enum(values)]).transform((v) => (v === "" ? null : v));
const wholeNumber = (min: number, max: number, message: string) =>
  z.union([z.literal(""), z.string().trim().regex(/^\d+$/, message)])
    .transform((v) => (v === "" ? null : Number(v)))
    .refine((v) => v === null || (v >= min && v <= max), message);
const flag = z.boolean().default(false);

export const itemEditSchema = z.object({
  sport: choice(SPORTS),
  year: wholeNumber(1860, 2100, "Enter a year between 1860 and 2100."),
  yearEnd: wholeNumber(1860, 2100, "Enter a year between 1860 and 2100."),
  brand: text(80),
  setName: text(120),
  cardNumber: text(30),
  player: text(120),
  team: text(80),
  variation: text(120),
  isRookie: flag,
  isError: flag,
  isParallel: flag,
  isInsert: flag,
  isAutograph: flag,
  isMemorabilia: flag,
  serialNumber: text(30),
  rarityTier: choice(RARITY_TIERS),
  condition: choice(CONDITIONS),
  conditionNotes: text(400),
  grader: text(20),
  grade: text(20),
  certNumber: text(40),
  productType: choice(PRODUCT_TYPES),
  packCount: wholeNumber(1, 100_000, "Enter a whole number from 1 to 100,000."),
  sealState: choice(SEAL_STATES),
  estCount: wholeNumber(1, 10_000_000, "Enter a whole number from 1 to 10,000,000."),
  containerType: text(80),
  description: text(600),
  quantity: z.union([z.number().int(), z.string().trim().regex(/^\d+$/)])
    .transform((v) => Number(v))
    .refine((v) => v >= 1 && v <= MAX_QUANTITY, "Enter a whole number from 1 to 100,000."),
  notes: text(600),
  locationId: wholeNumber(1, 2_000_000_000, "That location no longer exists."),
  manualValue: z.string().trim().transform((v, ctx) => {
    if (v === "") return null;
    const cents = parseDollars(v);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Enter a dollar amount like 12.50" });
      return z.NEVER;
    }
    return cents;
  }),
}).refine((v) => v.year === null || v.yearEnd === null || v.yearEnd >= v.year, {
  path: ["yearEnd"], message: "The last year cannot be before the first year.",
});

const FLAG_KEYS = new Set(["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"]);

export type ItemEditInput = z.input<typeof itemEditSchema>;
export type UpdateResult = { ok: true } | { ok: false; errors: Record<string, string> };

const GONE: UpdateResult = { ok: false, errors: { form: "This item no longer exists." } };

/** Fields each kind may change; the rest stay as they are (mirrors from-recognition.ts). */
const COMMON = ["sport", "year", "brand", "setName", "variation", "rarityTier", "conditionNotes", "quantity", "notes"] as const;
const CARD_ONLY = [
  "cardNumber", "player", "team", "isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia",
  "serialNumber", "condition", "grader", "grade", "certNumber",
] as const;
const SEALED_ONLY = ["productType", "packCount", "sealState"] as const;
const BULK_ONLY = ["yearEnd", "estCount", "containerType", "description"] as const;

export function editableFields(kind: Item["kind"]): readonly string[] {
  if (kind === "card") return [...COMMON, ...CARD_ONLY];
  if (kind === "sealed") return [...COMMON, ...SEALED_ONLY];
  return [...COMMON, ...BULK_ONLY];
}

export function updateItem(id: number, input: unknown, db: Db = getDb()): UpdateResult {
  const existing = db.select().from(items).where(eq(items.id, id)).get();
  if (!existing) return GONE;

  const raw: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  // A caller that does not send locationId leaves the location as it is.
  const keepLocation = raw.locationId === undefined;
  for (const key of Object.keys(itemEditSchema.shape)) {
    if (raw[key] == null) raw[key] = FLAG_KEYS.has(key) ? false : "";
  }
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
  if (!keepLocation && locationId !== null && !db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).get()) {
    return { ok: false, errors: { locationId: "That location no longer exists." } };
  }
  const patch: Partial<Item> = keepLocation ? {} : { locationId };
  for (const key of editableFields(existing.kind)) {
    (patch as Record<string, unknown>)[key] = (rest as Record<string, unknown>)[key];
  }
  const merged = { ...existing, ...patch };
  const now = new Date();
  db.transaction((tx) => {
    tx.update(items).set({
      ...patch,
      title: buildTitle(merged),
      manualValueCents: manualValue,
      updatedAt: now,
    }).where(eq(items.id, id)).run();
    if (manualValue !== null && manualValue !== existing.manualValueCents) {
      tx.insert(valuations).values({
        itemId: id, source: "manual", lowCents: null, highCents: null, valueCents: manualValue,
        basis: "Value entered by you.", createdAt: now,
      }).run();
    }
  });
  return { ok: true };
}

export function confirmItem(id: number, db: Db = getDb()): UpdateResult {
  const res = db.update(items).set({ status: "confirmed", updatedAt: new Date() }).where(eq(items.id, id)).run();
  return res.changes > 0 ? { ok: true } : GONE;
}

/**
 * Deletes an item: all its rows in one transaction, then its photo files.
 * The last item of a scan also takes the scan's own photos with it.
 */
export async function deleteItem(id: number, db: Db = getDb()): Promise<UpdateResult> {
  const files = db.transaction((tx) => removeItemRows(tx as unknown as Db, id), { behavior: "immediate" });
  if (files === null) return GONE;
  await deletePhotoFiles(files);
  return { ok: true };
}
