import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import {
  bulkOps, ITEM_KINDS, ITEM_STATUSES, items, locations, RARITY_TIERS, SPORTS, valuations,
  type BulkOpAction, type Item, type ItemStatus,
} from "@/db/schema";
import { formatCents } from "@/lib/money";
import { markOwnerChanges } from "@/lib/catalog/sources";
import { buildTitle } from "@/lib/title";
import { CONDITION_LABELS, RARITY_LABELS, SPORT_LABELS } from "./labels";
import { liveItem } from "./live";
import { readRookie, ROOKIE_STATE_LABELS, withRookie } from "./rookie";
import { ITEM_FLAGS, MISSING_FIELDS, matchingIds, type InventoryFilters } from "./query";
import { editableFields, itemEditSchema } from "./update";

/** Most ids one selection may list one by one. */
export const MAX_BULK_IDS = 500;
/** Most items one bulk change may touch. */
export const MAX_BULK_ITEMS = 5000;
/** Bulk changes kept for undo: the latest this many, none older than BULK_KEEP_DAYS. */
export const BULK_KEEP = 20;
export const BULK_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ids read per database statement, well under SQLite's limit on values. */
const CHUNK = 500;
const SAMPLES = 5;

const FLAG_FIELDS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"] as const;
/** Fields "Set a field" may change. `manualValue` is the owner's own value (dollars in, cents stored). */
export const BULK_FIELDS = [
  "sport", "year", "brand", "setName", "cardNumber", "player", "team", "variation", "condition", "rarityTier",
  ...FLAG_FIELDS, "quantity", "notes", "manualValue",
] as const;
export type BulkField = (typeof BULK_FIELDS)[number];
/** Fields "Find and replace" works on. */
export const BULK_TEXT_FIELDS = ["player", "team", "brand", "setName", "variation", "cardNumber", "notes", "description"] as const;
export type BulkTextField = (typeof BULK_TEXT_FIELDS)[number];

export const FIELD_LABELS: Record<BulkField | BulkTextField, string> = {
  sport: "sport", year: "year", brand: "brand", setName: "set name", cardNumber: "card number", player: "player",
  team: "team", variation: "variation", condition: "condition", rarityTier: "rarity", isRookie: "rookie",
  isError: "error card", isParallel: "parallel", isInsert: "insert", isAutograph: "autograph",
  isMemorabilia: "memorabilia", quantity: "quantity", notes: "notes", manualValue: "own value",
  description: "description",
};

/** Filters as the manager screen holds them (already parsed), without page and sort. */
export const selectionFiltersSchema = z.strictObject({
  q: z.string().trim().min(1, "Type something to search for.").max(100, "That search is too long.").optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  sport: z.enum(SPORTS).optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  tier: z.array(z.enum(RARITY_TIERS)).min(1, "Pick at least one rarity.").max(RARITY_TIERS.length, "Too many rarities picked.").optional(),
  rookie: z.literal(true).optional(),
  yearFrom: z.number().int().min(1860, "That first year is too early.").max(2100, "That first year is too far ahead.").optional(),
  yearTo: z.number().int().min(1860, "That last year is too early.").max(2100, "That last year is too far ahead.").optional(),
  location: z.union([z.literal("none"), z.number().int().min(1, "That location is not valid.").max(2_000_000_000, "That location is not valid.")]).optional(),
  value: z.literal("none").optional(),
  missing: z.enum(MISSING_FIELDS).optional(),
  flag: z.enum(ITEM_FLAGS).optional(),
  version: z.literal("not_sure").optional(),
  // Ignored: a bulk change covers every page, in any order.
  sort: z.unknown().optional(),
  page: z.unknown().optional(),
});
export type SelectionFilters = Omit<InventoryFilters, "sort" | "page">;

export type Selection = { ids: number[] } | { filters: InventoryFilters | SelectionFilters; expectedCount: number; fingerprint?: string };
export type BulkAction =
  | { type: "set"; field: BulkField; value: unknown; onlyEmpty: boolean; clear?: boolean }
  | { type: "replace"; field: BulkTextField; find: string; replace: string; matchCase: boolean }
  | { type: "move"; locationId: number | null }
  | { type: "status"; status: ItemStatus }
  | { type: "delete" };
export type BulkSample = { id: number; title: string; before: string; after: string };
/** `fingerprint` is for "all matching": a short stamp of the exact list of items the preview saw. */
export type BulkPreview = { count: number; samples: BulkSample[]; fingerprint: string };
type Fail = { error: string };

const idList = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(1, "Select at least one item first.")
  .max(MAX_BULK_IDS, `Tick up to ${MAX_BULK_IDS} items one by one, or use "Select all matching".`);
const selectionSchema = z.union([
  z.strictObject({ ids: idList }),
  z.strictObject({
    filters: selectionFiltersSchema,
    expectedCount: z.number().int().min(1, "Select at least one item first.").max(Number.MAX_SAFE_INTEGER),
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/, "The list changed. Look again.").optional(),
  }),
]);

export const bulkActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set"), field: z.enum(BULK_FIELDS), value: z.unknown(), onlyEmpty: z.boolean(), clear: z.boolean().default(false) }),
  z.strictObject({
    type: z.literal("replace"), field: z.enum(BULK_TEXT_FIELDS),
    find: z.string().min(1, "Type the text to find.").max(100, "Keep the text to find under 100 characters."),
    replace: z.string().max(100, "Keep the new text under 100 characters."),
    matchCase: z.boolean(),
  }),
  z.strictObject({ type: z.literal("move"), locationId: z.number().int().positive().max(2_000_000_000).nullable() }),
  z.strictObject({ type: z.literal("status"), status: z.enum(ITEM_STATUSES) }),
  z.strictObject({ type: z.literal("delete") }),
]);

/** Our own plain messages (limits) are shown; anything else gets the fallback. */
function firstMessage(e: z.ZodError, fallback: string): string {
  const issues = e.issues.flatMap((i) => (i.code === "invalid_union" ? i.errors.flat() : [i]));
  const own = issues.find((i) => i.code === "too_small" || i.code === "too_big");
  return own?.message ?? fallback;
}

/** Checks a selection from the browser. */
export function parseSelection(raw: unknown): Selection | Fail {
  const r = selectionSchema.safeParse(raw);
  if (!r.success) return { error: firstMessage(r.error, "Select the items again.") };
  return r.data as Selection;
}

/** Checks an action from the browser. The value of "Set a field" is checked later, per field. */
export function parseAction(raw: unknown): BulkAction | Fail {
  const r = bulkActionSchema.safeParse(raw);
  if (!r.success) return { error: firstMessage(r.error, "That change could not be read. Try again.") };
  return r.data as BulkAction;
}

// ---------------------------------------------------------------------------
// Which items

type Tx = Db;

function liveRows(tx: Tx, ids: number[]): Item[] {
  const unique = [...new Set(ids)];
  const out: Item[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    out.push(...tx.select().from(items).where(and(inArray(items.id, unique.slice(i, i + CHUNK)), liveItem)).all());
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A short stamp of a list of ids: sha256 of the sorted ids joined by commas, first 16 hex characters. */
export function fingerprintIds(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 16);
}

/**
 * The live items a selection covers, worked out on the server (deleted items are never in it).
 * With `strict` (apply), "all matching" must also carry the fingerprint the preview gave.
 */
function resolveSelection(tx: Tx, sel: Selection, strict = false): Item[] | Fail {
  if ("ids" in sel) {
    if (sel.ids.length === 0) return { error: "Select at least one item first." };
    if (new Set(sel.ids).size > MAX_BULK_IDS) return { error: `Tick up to ${MAX_BULK_IDS} items one by one, or use "Select all matching".` };
    return liveRows(tx, sel.ids);
  }
  const { sort: _sort, page: _page, ...filters } = sel.filters as InventoryFilters;
  const { ids, total } = matchingIds(filters, MAX_BULK_ITEMS, tx);
  if (total > MAX_BULK_ITEMS) {
    return { error: `That is more than ${MAX_BULK_ITEMS.toLocaleString("en-US")} items. Narrow the search and try again.` };
  }
  if (total !== sel.expectedCount || ids.length !== total) return { error: "The list changed. Look again." };
  const rows = liveRows(tx, ids);
  if (strict && sel.fingerprint !== fingerprintIds(rows.map((r) => r.id))) return { error: "The list changed. Look again." };
  return rows;
}

// ---------------------------------------------------------------------------
// What changes

type Columns = Partial<Record<keyof Item, unknown>>;
type Change = { id: number; title: string; patch: Columns; old: Columns; before: string; after: string; newValueCents?: number };
type Ctx = { locationNames: Map<number, string> };

const EMPTY = "(empty)";
const isEmpty = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

function show(field: BulkField | BulkTextField, v: unknown): string {
  if (v == null || v === "") return EMPTY;
  if (field === "manualValue") return formatCents(v as number);
  if ((FLAG_FIELDS as readonly string[]).includes(field)) return v ? "Yes" : "No";
  if (field === "sport") return SPORT_LABELS[v as keyof typeof SPORT_LABELS] ?? String(v);
  if (field === "condition") return CONDITION_LABELS[v as keyof typeof CONDITION_LABELS] ?? String(v);
  if (field === "rarityTier") return RARITY_LABELS[v as keyof typeof RARITY_LABELS] ?? String(v);
  return String(v);
}

const column = (field: BulkField | BulkTextField): keyof Item => (field === "manualValue" ? "manualValueCents" : field);
/** Fields an item of this kind has (the same list the item form uses). The own value applies to every kind. */
const appliesTo = (row: Item, field: BulkField | BulkTextField) => field === "manualValue" || editableFields(row.kind).includes(field);

/** Checks the value for "Set a field" with the same rules as the item form. Null or "" clears the field. */
function checkValue(field: BulkField, value: unknown): { value: unknown } | Fail {
  const isFlag = (FLAG_FIELDS as readonly string[]).includes(field);
  if (isFlag) {
    return typeof value === "boolean" ? { value } : { error: "Choose yes or no." };
  }
  let input: unknown = value;
  if (input === null || input === undefined) input = "";
  if (typeof input === "number" && (field === "year" || field === "quantity")) input = String(input);
  if (typeof input !== "string") return { error: "That value could not be read. Try again." };
  if (input.length > 1000) return { error: "That value is too long." };
  const piece = itemEditSchema.shape[field] as z.ZodType;
  const r = piece.safeParse(input);
  if (!r.success) return { error: r.error.issues[0]?.message ?? "That value could not be read. Try again." };
  return { value: r.data };
}

/** Plain text find and replace. Never a pattern: every character means itself. */
export function replaceText(text: string, find: string, replace: string, matchCase: boolean): string {
  if (find === "") return text;
  if (matchCase) return text.split(find).join(replace);
  // Escape every pattern character so the find text is matched as typed;
  // the replace text is given through a function so "$&" and the like stay as typed.
  const escaped = find.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  return text.replace(new RegExp(escaped, "giu"), () => replace);
}

function withTitle(row: Item, patch: Columns, change: Omit<Change, "patch" | "old">): Change {
  const merged = { ...row, ...patch } as Item;
  const title = buildTitle(merged);
  const fullPatch: Columns = { ...patch };
  if (title !== row.title) fullPatch.title = title;
  // A field the owner changes is theirs from now on. Undo puts the old marks back with the old values.
  const fieldSources = markOwnerChanges(row, patch);
  if (fieldSources !== undefined) fullPatch.fieldSources = fieldSources;
  const old: Columns = {};
  for (const key of Object.keys(fullPatch) as (keyof Item)[]) old[key] = row[key];
  return { ...change, patch: fullPatch, old };
}

function planChanges(tx: Tx, rows: Item[], action: BulkAction, ctx: Ctx): Change[] | Fail {
  const out: Change[] = [];
  switch (action.type) {
    case "set": {
      const isFlag = (FLAG_FIELDS as readonly string[]).includes(action.field);
      if (action.onlyEmpty && (isFlag || action.field === "quantity")) {
        return { error: "\"Only fill where empty\" does not work for yes or no fields or quantity. Turn it off." };
      }
      const clearing = action.clear === true;
      if (clearing && (isFlag || action.field === "quantity")) return { error: "That field cannot be cleared." };
      const given = !(action.value === null || action.value === undefined || (typeof action.value === "string" && action.value.trim() === ""));
      if (!clearing && !isFlag && !given) return { error: "Pick a value, or tick Clear this field." };
      // When clearing, any value sent is ignored.
      const checked = checkValue(action.field, clearing ? "" : action.value);
      if ("error" in checked) return checked;
      const col = column(action.field);
      let yearClash = 0;
      for (const row of rows) {
        if (!appliesTo(row, action.field)) continue;
        if (action.field === "isRookie") {
          // "Set rookie" is the owner's answer: state yes or no, source owner, with `isRookie` in step (withRookie).
          const target = checked.value ? "yes" : "no";
          const shown = readRookie(row).state;
          if (shown === target) continue;
          // "No" on a card with no rookie mark has nothing to change, so it is not counted or written.
          if (target === "no" && shown === null) continue;
          out.push(withTitle(row, withRookie(target, "owner"), {
            id: row.id, title: row.title, before: shown ? ROOKIE_STATE_LABELS[shown] : EMPTY, after: ROOKIE_STATE_LABELS[target],
          }));
          continue;
        }
        const current = row[col];
        if (action.onlyEmpty && !isEmpty(current)) continue;
        if (current === checked.value) continue;
        if (col === "year" && checked.value != null && row.yearEnd != null && row.yearEnd < (checked.value as number)) {
          yearClash += 1;
          continue;
        }
        const change = withTitle(row, { [col]: checked.value }, {
          id: row.id, title: row.title, before: show(action.field, current), after: show(action.field, checked.value),
        });
        if (col === "manualValueCents" && checked.value != null) change.newValueCents = checked.value as number;
        out.push(change);
      }
      if (yearClash > 0) {
        return { error: `${count(yearClash)} have a last year before that year. Nothing was changed. Leave them out and try again.` };
      }
      return out;
    }
    case "replace": {
      const piece = itemEditSchema.shape[action.field] as z.ZodType;
      let tooLong = 0;
      for (const row of rows) {
        if (!appliesTo(row, action.field)) continue;
        const current = row[action.field];
        if (typeof current !== "string" || current === "") continue;
        const replaced = replaceText(current, action.find, action.replace, action.matchCase);
        if (replaced === current) continue;
        const r = piece.safeParse(replaced);
        if (!r.success) { tooLong += 1; continue; }
        if (r.data === current) continue;
        out.push(withTitle(row, { [action.field]: r.data }, {
          id: row.id, title: row.title, before: show(action.field, current), after: show(action.field, r.data),
        }));
      }
      if (tooLong > 0) {
        return { error: `On ${count(tooLong)} the new ${FIELD_LABELS[action.field]} would be too long. Nothing was changed.` };
      }
      return out;
    }
    case "move": {
      if (action.locationId !== null && !tx.select({ id: locations.id }).from(locations).where(eq(locations.id, action.locationId)).get()) {
        return { error: "That location no longer exists." };
      }
      const name = (id: number | null) => (id == null ? "No location" : ctx.locationNames.get(id) ?? "No location");
      for (const row of rows) {
        if (row.locationId === action.locationId) continue;
        out.push({
          id: row.id, title: row.title, patch: { locationId: action.locationId }, old: { locationId: row.locationId },
          before: name(row.locationId), after: name(action.locationId),
        });
      }
      return out;
    }
    case "status": {
      const label = (s: ItemStatus) => (s === "confirmed" ? "Checked" : "Needs review");
      for (const row of rows) {
        if (row.status === action.status) continue;
        out.push({
          // Checking an item ends its catalog question; undo puts the candidates back.
          id: row.id, title: row.title,
          patch: action.status === "confirmed" && row.catalogCandidates != null ? { status: action.status, catalogCandidates: null } : { status: action.status },
          old: action.status === "confirmed" && row.catalogCandidates != null ? { status: row.status, catalogCandidates: row.catalogCandidates } : { status: row.status },
          before: label(row.status), after: label(action.status),
        });
      }
      return out;
    }
    case "delete": {
      for (const row of rows) {
        out.push({ id: row.id, title: row.title, patch: {}, old: { deletedAt: null }, before: "In the collection", after: "Recently deleted" });
      }
      return out;
    }
  }
}

const count = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

/** A few plain words for the undo notice and the activity log. Never the text of notes or any value typed. */
export function summarize(action: BulkAction, n: number, ctx: Ctx): string {
  switch (action.type) {
    case "set": {
      const label = FIELD_LABELS[action.field];
      const clears = action.clear === true;
      return `${clears ? "Cleared" : "Set"} ${label} on ${count(n)}`;
    }
    case "replace": return `Replaced text in ${FIELD_LABELS[action.field]} on ${count(n)}`;
    case "move": {
      const where = action.locationId == null ? "no location" : ctx.locationNames.get(action.locationId) ?? "a location";
      return `Moved ${count(n)} to ${where}`;
    }
    case "status": return `Marked ${count(n)} as ${action.status === "confirmed" ? "checked" : "needs review"}`;
    case "delete": return `Moved ${count(n)} to Recently deleted`;
  }
}

function context(tx: Tx): Ctx {
  return { locationNames: new Map(tx.select({ id: locations.id, name: locations.name }).from(locations).all().map((l) => [l.id, l.name])) };
}

function work(tx: Tx, sel: Selection, action: BulkAction, strict = false): { rows: Item[]; changes: Change[]; ctx: Ctx } | Fail {
  const rows = resolveSelection(tx, sel, strict);
  if ("error" in rows) return rows;
  const ctx = context(tx);
  const changes = planChanges(tx, rows, action, ctx);
  if ("error" in changes) return changes;
  return { rows, changes, ctx };
}

// ---------------------------------------------------------------------------
// Preview, apply, undo

/**
 * Step one, a dry run: how many items would change and up to five before and
 * after samples. Works out the selection and the changes with exactly the
 * code applyBulk uses, and writes nothing.
 */
export function previewBulk(sel: Selection, action: BulkAction, db: Db = getDb()): BulkPreview | Fail {
  return db.transaction((tx) => {
    const w = work(tx as unknown as Tx, sel, action);
    if ("error" in w) return w;
    return {
      count: w.changes.length,
      fingerprint: fingerprintIds(w.rows.map((r) => r.id)),
      samples: w.changes.slice(0, SAMPLES).map(({ id, title, before, after }) => ({ id, title, before, after })),
    };
  });
}

/** Undo data as stored in bulk_ops.undo. Times are milliseconds. */
const undoSchema = z.object({
  v: z.literal(1),
  /** "import" for a spreadsheet import (src/lib/import), stored with action "set". */
  kind: z.literal("import").optional(),
  items: z.array(z.tuple([z.number().int().positive(), z.record(z.string(), z.unknown())])),
  /** Items an import added: undo moves them to Recently deleted. */
  created: z.array(z.number().int().positive()).optional(),
});
const TIME_COLUMNS = new Set(["updatedAt", "deletedAt"]);
const toJson = (old: Columns) =>
  Object.fromEntries(Object.entries(old).map(([k, v]) => [k, v instanceof Date ? v.getTime() : v]));
const fromJson = (old: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(old).map(([k, v]) => [k, TIME_COLUMNS.has(k) && typeof v === "number" ? new Date(v) : v]));

/** Keeps the latest BULK_KEEP operations and none older than BULK_KEEP_DAYS. */
export function pruneOps(tx: Tx, now: Date): void {
  tx.delete(bulkOps).where(lt(bulkOps.at, new Date(now.getTime() - BULK_KEEP_DAYS * DAY_MS))).run();
  const edge = tx.select({ id: bulkOps.id }).from(bulkOps).orderBy(desc(bulkOps.id)).limit(1).offset(BULK_KEEP - 1).get();
  if (edge) tx.delete(bulkOps).where(lt(bulkOps.id, edge.id)).run();
}

/**
 * Step two: makes the change, all in one immediate transaction. The
 * selection is worked out again here; for "all matching" a different count
 * than the owner saw changes nothing. Saves the old values for undo.
 */
export function applyBulk(
  sel: Selection, action: BulkAction, db: Db = getDb(), now: Date = new Date(),
): { changed: number; opId: number; summary: string } | Fail {
  return db.transaction((txRaw) => {
    const tx = txRaw as unknown as Tx;
    const w = work(tx, sel, action, true);
    if ("error" in w) return w;
    if (w.changes.length === 0) return { error: "Nothing here needs this change." };
    const byId = new Map(w.rows.map((r) => [r.id, r]));
    for (const c of w.changes) {
      const set = action.type === "delete" ? { deletedAt: now } : { ...c.patch, updatedAt: now };
      const res = tx.update(items).set(set as Partial<Item>).where(and(eq(items.id, c.id), liveItem)).run();
      if (res.changes !== 1) throw new Error("bulk row changed during apply");
      if (c.newValueCents != null) {
        tx.insert(valuations).values({
          itemId: c.id, source: "manual", lowCents: null, highCents: null, valueCents: c.newValueCents,
          basis: "Value entered by you.", createdAt: now,
        }).run();
      }
    }
    const summary = summarize(action, w.changes.length, w.ctx);
    const undo = {
      v: 1,
      items: w.changes.map((c) => [c.id, toJson(action.type === "delete" ? c.old : { ...c.old, updatedAt: byId.get(c.id)!.updatedAt })]),
    };
    const op = tx.insert(bulkOps).values({
      at: now, action: action.type as BulkOpAction, summary, itemCount: w.changes.length, undo: JSON.stringify(undo),
    }).returning({ id: bulkOps.id }).get();
    pruneOps(tx, now);
    return { changed: w.changes.length, opId: op.id, summary };
  }, { behavior: "immediate" });
}

export type UndoableOp = { id: number; at: Date; summary: string; itemCount: number; action: BulkOpAction };

/** The latest bulk change that can still be undone, or null. */
export function latestUndoable(db: Db = getDb(), now: Date = new Date()): UndoableOp | null {
  // Only the latest change not yet undone; once it is undone the one before it is next.
  const op = db.select({ id: bulkOps.id, at: bulkOps.at, summary: bulkOps.summary, itemCount: bulkOps.itemCount, action: bulkOps.action })
    .from(bulkOps).where(isNull(bulkOps.undoneAt)).orderBy(desc(bulkOps.id)).limit(1).get();
  if (!op || op.at.getTime() < now.getTime() - BULK_KEEP_DAYS * DAY_MS) return null;
  return op;
}

/**
 * Puts back the old values of the latest bulk change not yet undone, for
 * items that still exist and were not edited since. Undo of a delete brings
 * the items back from Recently deleted. Reports how many were put back and
 * how many were skipped.
 */
export function undoBulk(opId: number, db: Db = getDb(), now: Date = new Date()): { restored: number; skipped: number; summary: string } | Fail {
  return db.transaction((txRaw) => {
    const tx = txRaw as unknown as Tx;
    const op = tx.select().from(bulkOps).where(eq(bulkOps.id, opId)).get();
    if (!op || op.at.getTime() < now.getTime() - BULK_KEEP_DAYS * DAY_MS) return { error: "This change can no longer be undone." };
    if (op.undoneAt) return { error: "This change was already undone." };
    const latest = tx.select({ id: bulkOps.id }).from(bulkOps).where(isNull(bulkOps.undoneAt)).orderBy(desc(bulkOps.id)).limit(1).get();
    if (latest?.id !== op.id) return { error: "Only the latest change can be undone." };
    let parsed: z.infer<typeof undoSchema>;
    try {
      parsed = undoSchema.parse(JSON.parse(op.undo));
    } catch {
      return { error: "This change can no longer be undone." };
    }
    const at = op.at.getTime();
    const locationIds = new Set(tx.select({ id: locations.id }).from(locations).all().map((l) => l.id));
    let restored = 0;
    let skipped = 0;
    // Reads deleted rows on purpose: undo of a delete brings them back.
    const rows = new Map<number, Item>();
    const created = parsed.created ?? [];
    const allIds = [...parsed.items.map(([id]) => id), ...created];
    for (let i = 0; i < allIds.length; i += CHUNK) {
      for (const r of tx.select().from(items).where(inArray(items.id, allIds.slice(i, i + CHUNK))).all()) rows.set(r.id, r);
    }
    for (const [id, oldJson] of parsed.items) {
      const row = rows.get(id);
      if (!row) { skipped += 1; continue; }
      if (op.action === "delete") {
        // Only items still in the bin from this very change.
        if (row.deletedAt?.getTime() !== at) { skipped += 1; continue; }
        tx.update(items).set({ deletedAt: null }).where(eq(items.id, id)).run();
        restored += 1;
        continue;
      }
      // Deleted since, or edited since: leave it as the owner left it.
      if (row.deletedAt != null || row.updatedAt.getTime() > at) { skipped += 1; continue; }
      const old = fromJson(oldJson) as Columns;
      // A change stored before Milestone 11 saved only `isRookie`: those items had no rookie state then, so the new columns go back to empty with it.
      if ("isRookie" in old && !("rookieState" in old)) Object.assign(old, { rookieState: null, rookieSource: null, rookieNote: null });
      if (typeof old.locationId === "number" && !locationIds.has(old.locationId)) { skipped += 1; continue; }
      tx.update(items).set(old as Partial<Item>).where(eq(items.id, id)).run();
      if ("manualValueCents" in old && old.manualValueCents != null && old.manualValueCents !== row.manualValueCents) {
        tx.insert(valuations).values({
          itemId: id, source: "manual", lowCents: null, highCents: null, valueCents: old.manualValueCents as number,
          basis: "Value put back by undo.", createdAt: now,
        }).run();
      }
      restored += 1;
    }
    // Items an import added go to Recently deleted, unless deleted or edited since.
    for (const id of created) {
      const row = rows.get(id);
      if (!row || row.deletedAt != null || row.updatedAt.getTime() > at) { skipped += 1; continue; }
      tx.update(items).set({ deletedAt: now }).where(and(eq(items.id, id), liveItem)).run();
      restored += 1;
    }
    tx.update(bulkOps).set({ undoneAt: now }).where(eq(bulkOps.id, op.id)).run();
    return { restored, skipped, summary: op.summary };
  }, { behavior: "immediate" });
}

/** For tests: the stored undo data of an operation. */
export function undoData(opId: number, db: Db = getDb()): unknown {
  const op = db.select({ undo: bulkOps.undo }).from(bulkOps).where(eq(bulkOps.id, opId)).get();
  return op ? JSON.parse(op.undo) : null;
}

/** Ids of every item in Recently deleted, for "Empty the bin". Reads deleted rows on purpose (the bin). */
export function binIds(db: Db = getDb()): number[] {
  return db.select({ id: items.id }).from(items).where(isNotNull(items.deletedAt)).all().map((r) => r.id);
}
