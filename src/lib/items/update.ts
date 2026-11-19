import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { CONDITIONS, items, locations, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS, valuations, type Item } from "@/db/schema";
import { markOwnerChanges } from "@/lib/catalog/sources";
import { MAX_QUANTITY } from "@/lib/items/duplicates";
import { softDeleteItems } from "@/lib/items/bin";
import { liveItem } from "@/lib/items/live";
import { readRookie, rookieStateSchema, withRookie } from "@/lib/items/rookie";
import { serialColumns, serialPartsSchema, splitSerial } from "@/lib/items/serial";
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
const COMMON = ["sport", "year", "brand", "setName", "variation", "rarityTier", "conditionNotes", "quantity", "notes", "description"] as const;
const CARD_ONLY = [
  "cardNumber", "player", "team", "isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia",
  "serialNumber", "condition", "grader", "grade", "certNumber",
] as const;
const SEALED_ONLY = ["productType", "packCount", "sealState"] as const;
const BULK_ONLY = ["yearEnd", "estCount", "containerType"] as const;

export function editableFields(kind: Item["kind"]): readonly string[] {
  if (kind === "card") return [...COMMON, ...CARD_ONLY];
  if (kind === "sealed") return [...COMMON, ...SEALED_ONLY];
  return [...COMMON, ...BULK_ONLY];
}

/**
 * The new serial and rookie fields a form may send besides `itemEditSchema`.
 * Left out: the form of today (one serial text, one rookie check box) is used.
 */
const ownerExtrasSchema = z.object({
  serialCopy: z.string().optional(),
  serialEdition: z.string().optional(),
  rookieState: z.union([z.literal(""), rookieStateSchema]).optional(),
});

type ExtrasResult = { ok: true; patch: Partial<Item> } | { ok: false; errors: Record<string, string> };

/**
 * Keeps the old and the new serial and rookie columns in step when the owner
 * saves a card (item form, Add by hand):
 * - Serial: the two boxes when sent, else the one text. A text that splits
 *   ("045/100", "45 of 100", "/100") fills the parts and is rebuilt as
 *   "045/100"; one that does not ("1 of 1 promo") is kept whole, parts empty.
 * - Rookie: written only when the owner changed the answer shown, always with
 *   source `owner` and through withRookie(), so `isRookie` never disagrees.
 */
export function ownerSerialAndRookie(
  existing: Pick<Item, "isRookie" | "rookieState" | "rookieSource" | "rookieNote" | "serialNumber"> | null,
  data: { serialNumber: string | null; isRookie: boolean },
  input: Record<string, unknown>,
  /** True when the caller sent the one serial text box at all (even empty). */
  serialTextSent = true,
): ExtrasResult {
  const extras = ownerExtrasSchema.safeParse({ serialCopy: input.serialCopy, serialEdition: input.serialEdition, rookieState: input.rookieState });
  if (!extras.success) return { ok: false, errors: { form: "Some fields could not be read. Try again." } };
  const { serialCopy, serialEdition, rookieState } = extras.data;

  let patch: Partial<Item>;
  if (serialCopy !== undefined || serialEdition !== undefined) {
    const parts = serialPartsSchema.safeParse({ serialCopy: serialCopy ?? "", serialEdition: serialEdition ?? "" });
    if (!parts.success) {
      const issue = parts.error.issues[0];
      return { ok: false, errors: { [String(issue?.path[0] ?? "serialEdition")]: issue?.message ?? "Check the serial number." } };
    }
    patch = serialColumns(parts.data);
    if (parts.data === null && data.serialNumber !== null) {
      // The two boxes are empty but the one text box was filled: it splits, or it is kept whole ("1 of 1 promo").
      const split = splitSerial(data.serialNumber);
      patch = split ? serialColumns(split) : { serialNumber: data.serialNumber, serialCopy: null, serialEdition: null };
    } else if (parts.data === null && !serialTextSent && existing?.serialNumber && !splitSerial(existing.serialNumber)) {
      // Empty boxes never wipe an old whole text that does not split. Only the text box (or a form without boxes) can change it.
      patch = {};
    }
  } else {
    const parts = splitSerial(data.serialNumber);
    patch = parts ? serialColumns(parts) : { serialNumber: data.serialNumber, serialCopy: null, serialEdition: null };
  }

  const shown = existing ? readRookie(existing).state : null;
  if (rookieState !== undefined) {
    if (rookieState !== "" && rookieState !== shown) Object.assign(patch, withRookie(rookieState, "owner"));
  } else {
    const was = existing?.isRookie ?? false;
    if (data.isRookie !== was) Object.assign(patch, withRookie(data.isRookie ? "yes" : "no", "owner"));
  }
  return { ok: true, patch };
}

export function updateItem(id: number, input: unknown, db: Db = getDb()): UpdateResult {
  const existing = db.select().from(items).where(and(eq(items.id, id), liveItem)).get();
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
  if (existing.kind === "card") {
    const extras = ownerSerialAndRookie(existing, rest, raw, typeof (input as Record<string, unknown> | null)?.serialNumber === "string");
    if (!extras.ok) return extras;
    // The rookie mark changes only through withRookie(); the plain flag from the form never goes in alone.
    delete patch.isRookie;
    delete patch.serialNumber;
    Object.assign(patch, extras.patch);
  }
  // A new variation means the version must be chosen again, unless it is the current version's name.
  if (typeof patch.variation === "string" || patch.variation === null) {
    const sameName = (a: string | null | undefined) => (a ?? "").trim().toLowerCase();
    if (sameName(patch.variation) !== sameName(existing.variation)) {
      patch.versionState = null;
      patch.versionSource = null;
    }
  }
  // Every catalog field the owner changed is theirs from now on. `firstSuggestion` is never part of a patch.
  const fieldSources = markOwnerChanges(existing, patch);
  if (fieldSources !== undefined) patch.fieldSources = fieldSources;
  const merged = { ...existing, ...patch };
  const now = new Date();
  db.transaction((tx) => {
    tx.update(items).set({
      ...patch,
      title: buildTitle(merged),
      manualValueCents: manualValue,
      updatedAt: now,
    }).where(and(eq(items.id, id), liveItem)).run();
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
  // Confirming also ends the catalog question: the candidates are cleared.
  const res = db.update(items).set({ status: "confirmed", catalogCandidates: null, updatedAt: new Date() }).where(and(eq(items.id, id), liveItem)).run();
  return res.changes > 0 ? { ok: true } : GONE;
}

/**
 * Deletes an item: it moves to Recently deleted with its photos and value
 * history, and is removed for good after BIN_DAYS days (see bin.ts).
 */
export function deleteItem(id: number, db: Db = getDb()): UpdateResult {
  return softDeleteItems([id], db) > 0 ? { ok: true } : GONE;
}
