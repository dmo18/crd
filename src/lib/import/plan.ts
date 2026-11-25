import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { bulkOps, items, locations, valuations, type Item, type NewItem } from "@/db/schema";
import { markOwnerChanges } from "@/lib/catalog/sources";
import { normalizeBrand, normalizeName, printedCardNumber } from "@/lib/catalog/normalize";
import { pruneOps } from "@/lib/items/bulk";
import { insertPrepared, prepareNewItem } from "@/lib/items/create";
import { MAX_QUANTITY } from "@/lib/items/duplicates";
import { CONDITION_LABELS, KIND_LABELS, PRODUCT_LABELS, RARITY_LABELS, SEAL_LABELS } from "@/lib/items/labels";
import { liveItem } from "@/lib/items/live";
import { withRookie } from "@/lib/items/rookie";
import { serialColumns, splitSerial } from "@/lib/items/serial";
import { clearVersionOnNewVariation, editableFields, itemEditSchema } from "@/lib/items/update";
import { formatCents } from "@/lib/money";
import { buildTitle } from "@/lib/title";
import { refreshGuideQuietly } from "@/lib/valuation/guide/apply";
import {
  cleanCell, cleanMoney, cleanYear, FIRST_YEAR, lastYear, listOf, matchCondition, matchKind, matchProduct, matchRarity,
  matchSeal, matchSport, yesNo,
} from "./clean";
import { parseCsv } from "./csv";
import { IMPORT_FIELD_NAMES, IMPORT_FIELDS, SKIP, type ColumnChoice, type ImportField } from "./fields";

/**
 * The spreadsheet import (Milestone 12): checks every row with the rules of
 * Add by hand, finds rows that update an item (by ID) or look like one the
 * owner already has, and saves everything in one transaction, recorded as
 * one bulk change that Manage records can undo.
 */

export const DUPLICATE_CHOICES = ["skip", "new", "add"] as const;
export type DuplicateChoice = (typeof DUPLICATE_CHOICES)[number];
export type ImportOptions = { unknownSportOther: boolean; duplicates: DuplicateChoice };

/** Rows shown "as they will be saved" in the preview. */
export const PREVIEW_ROWS = 20;
/** Problems listed one by one; the count is always complete. */
export const MAX_PROBLEMS_SHOWN = 300;
const SHOWN_CHANGES = 50;
const CHUNK = 500;
const LOCATION_NAME_MAX = 60;

const FLAG_FIELDS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"] as const;
type FlagField = (typeof FLAG_FIELDS)[number];
const isFlag = (f: ImportField): f is FlagField => (FLAG_FIELDS as readonly string[]).includes(f);

type Columns = Partial<Record<keyof Item, unknown>>;
type Fail = { error: string };

export type Problem = { row: number; message: string };

/** What happens to one row. `row` is the spreadsheet row number (the header is row 1). */
type Outcome =
  | { type: "blank"; row: number }
  | { type: "problem"; row: number }
  | { type: "new"; row: number; item: NewItem; manualValue: number | null; location: string | null; duplicateOf?: number }
  | { type: "update"; row: number; id: number }
  | { type: "unchanged"; row: number; id: number }
  | { type: "duplicate_skipped"; row: number; matchId: number; title: string }
  | { type: "add_quantity"; row: number; id: number; add: number };

/** The planned change of one existing item (an ID row, quantities added, or both). */
type Pending = { existing: Item; patch: Columns; location: string | null | undefined; manualValue?: number | null };

export type ImportCounts = {
  /** Rows with cards in them (empty rows are not counted). */
  rows: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Rows that looked like an item already in the collection, whatever was chosen for them. */
  duplicates: number;
  problems: number;
};

export type PreviewRow = {
  row: number;
  action: "Add" | "Update" | "No change" | "Skip, already have it" | "Add to quantity" | "Add as new";
  title: string;
  details: string;
};

export type ImportPreview = {
  counts: ImportCounts;
  rows: PreviewRow[];
  problems: Problem[];
  /** Rows that look like an item already in the collection, the first 50. */
  duplicates: { row: number; title: string; matchId: number; matchTitle: string }[];
  newLocations: string[];
};

type Plan = {
  outcomes: Outcome[];
  pending: Map<number, Pending>;
  problems: Problem[];
  counts: ImportCounts;
  newLocations: string[];
  preview: PreviewRow[];
  duplicates: ImportPreview["duplicates"];
};

const mappingSchema = z.array(z.enum([...IMPORT_FIELDS, SKIP])).min(1).max(200);

/** Checks the column choices: one column per app field at most, and at least one field chosen. */
export function checkMapping(raw: unknown, width: number): ColumnChoice[] | Fail {
  const r = mappingSchema.safeParse(raw);
  if (!r.success || r.data.length !== width) return { error: "The column choices could not be read. Pick the file again." };
  const seen = new Set<ImportField>();
  for (const c of r.data) {
    if (c === SKIP) continue;
    if (seen.has(c)) return { error: `Two columns are set to "${IMPORT_FIELD_NAMES[c]}". Choose it for one column only.` };
    seen.add(c);
  }
  if (seen.size === 0 || (seen.size === 1 && seen.has("id"))) return { error: "Choose at least one column to bring in." };
  return r.data;
}

/** Year, brand, card number and player, with case, accents and punctuation ignored. Null without a player or without year and brand. */
export function duplicateKey(f: Pick<Item, "year" | "brand" | "cardNumber" | "player">): string | null {
  const player = normalizeName(f.player ?? "");
  if (player === "" || (f.year == null && normalizeBrand(f.brand ?? "") === "")) return null;
  return [f.year ?? "", normalizeBrand(f.brand ?? ""), printedCardNumber(f.cardNumber ?? ""), player].join("|");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function details(f: Partial<Item>, location: string | null | undefined): string {
  return [
    f.quantity != null && f.quantity !== 1 ? `Quantity ${f.quantity}` : null,
    f.condition ? CONDITION_LABELS[f.condition] : null,
    f.grader || f.grade ? [f.grader, f.grade].filter(Boolean).join(" ") : null,
    f.manualValueCents != null ? `Your value ${formatCents(f.manualValueCents)}` : null,
    location ? `In ${location}` : null,
  ].filter(Boolean).join(" · ");
}

/** Reads one row's mapped cells into checked values, or problems. */
function readRow(cells: string[], mapping: ColumnChoice[]): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  mapping.forEach((field, i) => { if (field !== SKIP) out[field] = cleanCell(cells[i]); });
  return out;
}

type Checked = {
  /** Text values as itemEditSchema takes them, for the mapped fields only. */
  input: Record<string, string | boolean>;
  id: number | null;
  kind: Item["kind"] | null;
  location: string | null | undefined;
  manualValue: number | null | undefined;
};

/** The safe cleaning rules, field by field. Adds a plain problem for each cell that cannot be used. */
function checkCells(v: Partial<Record<ImportField, string>>, opts: ImportOptions, now: Date, problem: (m: string) => void): Checked {
  const input: Record<string, string | boolean> = {};
  let id: number | null = null;
  let kind: Item["kind"] | null = null;
  let location: string | null | undefined;
  let manualValue: number | null | undefined;
  const top = lastYear(now);
  for (const field of Object.keys(v) as ImportField[]) {
    const s = v[field] ?? "";
    const name = IMPORT_FIELD_NAMES[field];
    if (field === "id") {
      if (s === "") continue;
      if (!/^\d{1,15}$/.test(s) || Number(s) < 1) { problem(`ID must be the number from the app's own export. Clear it to add this row as new.`); continue; }
      id = Number(s);
    } else if (field === "kind") {
      if (s === "") continue;
      const k = matchKind(s);
      if (!k) problem(`Kind must be one of: ${listOf(KIND_LABELS)}.`);
      else kind = k;
    } else if (isFlag(field)) {
      const b = yesNo(s);
      if (b === "bad") problem(`${name} must be yes or no (also Y, N, true, false, x).`);
      else if (b !== null) input[field] = b;
    } else if (field === "year" || field === "yearEnd") {
      if (s === "") { input[field] = ""; continue; }
      const y = cleanYear(s);
      if (y === null || y < FIRST_YEAR || y > top) problem(`${name} must be a number between ${FIRST_YEAR} and ${top}.`);
      else input[field] = String(y);
    } else if (field === "quantity") {
      if (s === "") continue;
      const q = s.replace(/,/g, "");
      if (!/^\d{1,6}$/.test(q) || Number(q) < 1 || Number(q) > MAX_QUANTITY) problem(`Quantity must be a whole number from 1 to ${MAX_QUANTITY.toLocaleString("en-US")}.`);
      else input.quantity = String(Number(q));
    } else if (field === "manualValue") {
      if (s === "") { manualValue = null; continue; }
      const cents = cleanMoney(s);
      if (cents === null) problem(`Value must be a dollar amount like 12.50 or $1,234.50.`);
      else manualValue = cents;
    } else if (field === "location") {
      if (s === "") { location = null; continue; }
      if (s.length > LOCATION_NAME_MAX) problem(`Location names must be under ${LOCATION_NAME_MAX} characters.`);
      else location = s.replace(/\s+/g, " ");
    } else if (field === "sport") {
      if (s === "") { input.sport = ""; continue; }
      const sp = matchSport(s);
      if (sp) input.sport = sp;
      else if (opts.unknownSportOther) input.sport = "other";
      else problem(`Sport "${s.slice(0, 40)}" is not one the app knows. Fix it, or tick "Unknown sports become Other".`);
    } else if (field === "condition" || field === "rarityTier" || field === "productType" || field === "sealState") {
      if (s === "") { input[field] = ""; continue; }
      const [match, labels] = field === "condition" ? [matchCondition(s), CONDITION_LABELS]
        : field === "rarityTier" ? [matchRarity(s), RARITY_LABELS]
        : field === "productType" ? [matchProduct(s), PRODUCT_LABELS] : [matchSeal(s), SEAL_LABELS];
      if (match) input[field] = match;
      else problem(`${name} must be one of: ${listOf(labels)}.`);
    } else {
      input[field] = s;
    }
  }
  return { input, id, kind, location, manualValue };
}

const key = (field: string) => (IMPORT_FIELD_NAMES as Record<string, string>)[field === "locationId" ? "location" : field] ?? null;

/** Turns the item form's messages ({ year: "Enter a year ..." }) into row problems. */
function formProblems(errors: Record<string, string>, problem: (m: string) => void) {
  for (const [field, message] of Object.entries(errors)) {
    const name = field === "serialCopy" || field === "serialEdition" ? "Serial number" : key(field);
    problem(name && field !== "form" ? `${name}: ${message}` : message);
  }
}

/** The patch for an item the row updates: only the mapped columns that changed. */
function updatePatch(existing: Item, c: Checked, problem: (m: string) => void): { patch: Columns } {
  const patch: Columns = {};
  const allowed = new Set(editableFields(existing.kind));
  const shape = itemEditSchema.shape as Record<string, z.ZodType>;
  for (const [field, value] of Object.entries(c.input)) {
    if (!allowed.has(field)) continue;
    if (field === "isRookie") {
      // Only a real change: the export writes "No" for every card not marked yes (also "Not sure"), so "No" on those changes nothing.
      if (value !== existing.isRookie) Object.assign(patch, withRookie(value ? "yes" : "no", "owner"));
      continue;
    }
    const r = shape[field].safeParse(value);
    if (!r.success) { problem(`${key(field)}: ${r.error.issues[0]?.message ?? "This value cannot be used."}`); continue; }
    if (field === "serialNumber") {
      const text = r.data as string | null;
      if (text === existing.serialNumber) continue;
      const parts = splitSerial(text);
      Object.assign(patch, parts ? serialColumns(parts) : { serialNumber: text, serialCopy: null, serialEdition: null });
      continue;
    }
    patch[field as keyof Item] = r.data;
  }
  if (c.manualValue !== undefined) patch.manualValueCents = c.manualValue;
  const year = ("year" in patch ? patch.year : existing.year) as number | null;
  const yearEnd = ("yearEnd" in patch ? patch.yearEnd : existing.yearEnd) as number | null;
  if (year != null && yearEnd != null && yearEnd < year) problem("Last year: The last year cannot be before the first year.");
  // A new variation means the version must be chosen again (as the item form does).
  clearVersionOnNewVariation(existing, patch);
  for (const k of Object.keys(patch) as (keyof Item)[]) if (patch[k] === existing[k]) delete patch[k];
  return { patch };
}

type LiveLookup = {
  byId: (ids: number[]) => Map<number, Item>;
  dupIndex: () => Map<string, { id: number; title: string }>;
  locationIds: Map<string, number>;
  locationName: (id: number | null) => string | null;
};

function lookups(tx: Db): LiveLookup {
  let index: Map<string, { id: number; title: string }> | null = null;
  const places = tx.select({ id: locations.id, name: locations.name }).from(locations).all();
  const names = new Map(places.map((l) => [l.id, l.name]));
  return {
    byId(ids) {
      const out = new Map<number, Item>();
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += CHUNK) {
        for (const r of tx.select().from(items).where(and(inArray(items.id, unique.slice(i, i + CHUNK)), liveItem)).all()) out.set(r.id, r);
      }
      return out;
    },
    dupIndex() {
      if (index) return index;
      index = new Map();
      const rows = tx.select({ id: items.id, title: items.title, year: items.year, brand: items.brand, cardNumber: items.cardNumber, player: items.player })
        .from(items).where(and(eq(items.kind, "card"), liveItem)).orderBy(items.id).all();
      for (const r of rows) {
        const k = duplicateKey(r);
        if (k !== null && !index.has(k)) index.set(k, { id: r.id, title: r.title });
      }
      return index;
    },
    locationIds: new Map(places.map((l) => [l.name.toLowerCase(), l.id])),
    locationName: (id) => (id == null ? null : names.get(id) ?? null),
  };
}

/** Works out what every row would do. Writes nothing. */
function plan(tx: Db, rows: string[][], mapping: ColumnChoice[], opts: ImportOptions, now: Date): Plan {
  const look = lookups(tx);
  const problems: Problem[] = [];
  const outcomes: Outcome[] = [];
  const pending = new Map<number, Pending>();
  const newLocations = new Map<string, string>();
  const preview: PreviewRow[] = [];
  const duplicates: ImportPreview["duplicates"] = [];
  const counts: ImportCounts = { rows: 0, added: 0, updated: 0, unchanged: 0, duplicates: 0, problems: 0 };

  const idCol = mapping.indexOf("id");
  const wanted = idCol < 0 ? [] : rows.map((r) => cleanCell(r[idCol])).filter((s) => /^\d{1,15}$/.test(s)).map(Number);
  const live = look.byId(wanted);
  const idRow = new Map<number, number>();

  const noteLocation = (name: string | null | undefined) => {
    if (name && !look.locationIds.has(name.toLowerCase()) && !newLocations.has(name.toLowerCase())) newLocations.set(name.toLowerCase(), name);
  };
  const show = (p: PreviewRow) => { if (preview.length < PREVIEW_ROWS) preview.push(p); };

  rows.forEach((cells, index) => {
    const row = index + 2;
    const values = readRow(cells, mapping);
    if (Object.values(values).every((s) => s === "")) { outcomes.push({ type: "blank", row }); return; }
    counts.rows += 1;
    const mine: string[] = [];
    const problem = (m: string) => mine.push(m);
    const c = checkCells(values, opts, now, problem);
    const finish = (o: Outcome) => {
      if (mine.length > 0) {
        counts.problems += 1;
        for (const m of mine) problems.push({ row, message: `Row ${row}: ${m}` });
        outcomes.push({ type: "problem", row });
        return false;
      }
      outcomes.push(o);
      return true;
    };

    if (c.id !== null) {
      const existing = live.get(c.id);
      if (!existing) problem(`There is no item with ID ${c.id} in your collection (it may have been deleted). Clear the ID to add this row as new.`);
      else if (idRow.has(c.id)) problem(`ID ${c.id} is also on row ${idRow.get(c.id)}. Each item can be on one row only.`);
      else if (c.kind !== null && c.kind !== existing.kind) problem(`Kind cannot be changed by an import (this item is a ${KIND_LABELS[existing.kind].toLowerCase()}).`);
      if (!existing || mine.length > 0) { finish({ type: "problem", row }); return; }
      idRow.set(c.id, row);
      const { patch } = updatePatch(existing, c, problem);
      if (mine.length > 0) { finish({ type: "problem", row }); return; }
      const before = pending.get(c.id);
      const merged = before ? { ...before.patch, ...patch } : patch;
      const changed = Object.keys(merged).length > 0 || (c.location !== undefined && c.location?.toLowerCase() !== look.locationName(existing.locationId)?.toLowerCase());
      if (!changed) {
        finish({ type: "unchanged", row, id: c.id });
        counts.unchanged += 1;
        show({ row, action: "No change", title: existing.title, details: "" });
        return;
      }
      noteLocation(c.location);
      pending.set(c.id, { existing, patch: merged, location: c.location !== undefined ? c.location : before?.location });
      finish({ type: "update", row, id: c.id });
      if (!before) counts.updated += 1;
      const after = { ...existing, ...merged } as Item;
      show({ row, action: "Update", title: buildTitle(after), details: details(after, c.location) });
      return;
    }

    // A new row: exactly the checks of Add by hand.
    const kind = c.kind ?? "card";
    const input: Record<string, unknown> = { ...c.input };
    if (c.manualValue != null) input.manualValue = (c.manualValue / 100).toFixed(2);
    const prepared = prepareNewItem(kind, input, tx, now);
    if (!prepared.ok) { formProblems(prepared.errors, problem); finish({ type: "problem", row }); return; }
    const item = prepared.row;
    const dupKey = kind === "card" ? duplicateKey({ year: item.year ?? null, brand: item.brand ?? null, cardNumber: item.cardNumber ?? null, player: item.player ?? null }) : null;
    const match = dupKey ? look.dupIndex().get(dupKey) : undefined;
    if (match && mine.length === 0) {
      counts.duplicates += 1;
      if (duplicates.length < SHOWN_CHANGES) duplicates.push({ row, title: item.title, matchId: match.id, matchTitle: match.title });
      if (opts.duplicates === "skip") {
        finish({ type: "duplicate_skipped", row, matchId: match.id, title: item.title });
        show({ row, action: "Skip, already have it", title: item.title, details: `You have: ${match.title}` });
        return;
      }
      if (opts.duplicates === "add") {
        const add = item.quantity ?? 1;
        const base = pending.get(match.id) ?? (() => {
          const existing = look.byId([match.id]).get(match.id)!;
          return { existing, patch: {}, location: undefined } as Pending;
        })();
        const current = (base.patch.quantity as number | undefined) ?? base.existing.quantity;
        if (current + add > MAX_QUANTITY) { problem(`Adding ${add} would take the quantity of "${match.title}" over ${MAX_QUANTITY.toLocaleString("en-US")}.`); finish({ type: "problem", row }); return; }
        const wasPending = pending.has(match.id);
        base.patch = { ...base.patch, quantity: current + add };
        pending.set(match.id, base);
        finish({ type: "add_quantity", row, id: match.id, add });
        if (!wasPending) counts.updated += 1;
        show({ row, action: "Add to quantity", title: match.title, details: `Quantity ${current} becomes ${current + add}` });
        return;
      }
    }
    noteLocation(c.location);
    if (finish({ type: "new", row, item, manualValue: prepared.manualValue, location: c.location ?? null, duplicateOf: match?.id })) {
      counts.added += 1;
      show({ row, action: match ? "Add as new" : "Add", title: item.title, details: details(item as Partial<Item>, c.location) });
    }
  });

  return { outcomes, pending, problems, counts, newLocations: [...newLocations.values()], preview, duplicates };
}

function toPreview(p: Plan): ImportPreview {
  return {
    counts: p.counts, rows: p.preview, problems: p.problems.slice(0, MAX_PROBLEMS_SHOWN),
    duplicates: p.duplicates, newLocations: p.newLocations,
  };
}

const optionsSchema = z.strictObject({ unknownSportOther: z.boolean(), duplicates: z.enum(DUPLICATE_CHOICES) });

export function parseOptions(raw: unknown): ImportOptions | Fail {
  const r = optionsSchema.safeParse(raw);
  return r.success ? r.data : { error: "The import choices could not be read. Try again." };
}

function readFile(text: string, rawMapping: unknown): { rows: string[][]; mapping: ColumnChoice[] } | Fail {
  const csv = parseCsv(text);
  if (!csv.ok) return { error: csv.error };
  const mapping = checkMapping(rawMapping, csv.header.length);
  if ("error" in mapping) return mapping;
  return { rows: csv.rows, mapping };
}

/** Step 3: what the import would do. Writes nothing. */
export function previewImport(text: string, rawMapping: unknown, opts: ImportOptions, db: Db = getDb(), now: Date = new Date()): ImportPreview | Fail {
  const file = readFile(text, rawMapping);
  if ("error" in file) return file;
  // A read transaction, so the whole check sees one moment of the collection.
  return db.transaction((tx) => {
    const p = plan(tx as unknown as Db, file.rows, file.mapping, opts, now);
    return toPreview(p);
  });
}

export type ImportResult = {
  opId: number;
  summary: string;
  added: number;
  updated: number;
  skipped: number;
  addedItems: { id: number; title: string }[];
  updatedItems: { id: number; title: string }[];
};

/** For tests: lets a test fail on purpose while rows are being saved. */
export type ImportHooks = { beforeSave?: (index: number) => void };

/**
 * Step 4: saves every row in one immediate transaction. Any error rolls
 * everything back. The rows are checked again here; when the counts differ
 * from the preview the owner saw, nothing is saved. Recorded as one bulk
 * change (bulk_ops) so Manage records can undo it.
 */
export function applyImport(
  text: string, rawMapping: unknown, opts: ImportOptions,
  confirm: { skipProblems: boolean; expected?: ImportCounts },
  db: Db = getDb(), now: Date = new Date(), hooks: ImportHooks = {},
): ImportResult | Fail {
  const file = readFile(text, rawMapping);
  if ("error" in file) return file;
  // Items the import saved: they get a guide price once the save is done (never an owner value, never `updatedAt`).
  const touched: number[] = [];
  const result = db.transaction((txRaw) => {
    const tx = txRaw as unknown as Db;
    const p = plan(tx, file.rows, file.mapping, opts, now);
    const c = p.counts;
    if (confirm.expected && JSON.stringify(confirm.expected) !== JSON.stringify(c)) {
      return { error: "Your collection changed since the check. Check the file again." };
    }
    if (c.problems > 0 && !confirm.skipProblems) {
      return { error: `${plural(c.problems, "row has", "rows have")} problems. Fix them, or choose to skip them.` };
    }
    if (c.added === 0 && c.updated === 0) return { error: "Nothing to bring in: every row is already in your collection or has a problem." };

    // New locations first (names checked above), found again by name, any capitals.
    const locationIds = new Map(tx.select({ id: locations.id, name: locations.name }).from(locations).all().map((l) => [l.name.toLowerCase(), l.id]));
    for (const name of p.newLocations) {
      const made = tx.insert(locations).values({ name, createdAt: now }).returning({ id: locations.id }).get();
      locationIds.set(name.toLowerCase(), made.id);
    }
    const locId = (name: string | null) => (name == null ? null : locationIds.get(name.toLowerCase()) ?? null);

    const created: number[] = [];
    const addedItems: ImportResult["addedItems"] = [];
    let step = 0;
    for (const o of p.outcomes) {
      if (o.type !== "new") continue;
      hooks.beforeSave?.(step++);
      const id = insertPrepared(tx, { ...o.item, locationId: locId(o.location) }, o.manualValue, now);
      created.push(id);
      touched.push(id);
      if (addedItems.length < SHOWN_CHANGES) addedItems.push({ id, title: o.item.title });
    }

    const undoItems: [number, Record<string, unknown>][] = [];
    const updatedItems: ImportResult["updatedItems"] = [];
    for (const [id, u] of p.pending) {
      hooks.beforeSave?.(step++);
      const patch: Columns = { ...u.patch };
      if (u.location !== undefined) patch.locationId = locId(u.location);
      for (const k of Object.keys(patch) as (keyof Item)[]) if (patch[k] === u.existing[k]) delete patch[k];
      if (Object.keys(patch).length === 0) continue;
      const merged = { ...u.existing, ...patch } as Item;
      const title = buildTitle(merged);
      if (title !== u.existing.title) patch.title = title;
      // Every catalog field the owner changed is theirs from now on.
      const fieldSources = markOwnerChanges(u.existing, patch);
      if (fieldSources !== undefined) patch.fieldSources = fieldSources;
      const old: Record<string, unknown> = {};
      for (const k of Object.keys(patch) as (keyof Item)[]) old[k] = u.existing[k];
      old.updatedAt = u.existing.updatedAt.getTime();
      const res = tx.update(items).set({ ...(patch as Partial<Item>), updatedAt: now }).where(and(eq(items.id, id), liveItem)).run();
      if (res.changes !== 1) throw new Error("import row changed during apply");
      if ("manualValueCents" in patch && patch.manualValueCents != null) {
        tx.insert(valuations).values({
          itemId: id, source: "manual", lowCents: null, highCents: null, valueCents: patch.manualValueCents as number,
          basis: "Value entered by you.", createdAt: now,
        }).run();
      }
      undoItems.push([id, old]);
      touched.push(id);
      if (updatedItems.length < SHOWN_CHANGES) updatedItems.push({ id, title: (patch.title as string | undefined) ?? u.existing.title });
    }
    if (created.length === 0 && undoItems.length === 0) throw new Error("import had nothing to save");

    const summary = `Imported a spreadsheet: ${created.length.toLocaleString("en-US")} added, ${undoItems.length.toLocaleString("en-US")} updated`;
    const op = tx.insert(bulkOps).values({
      // bulk_ops has no "import" action; "set" with `kind: "import"` in the undo data marks it (no schema change).
      at: now, action: "set", summary, itemCount: created.length + undoItems.length,
      undo: JSON.stringify({ v: 1, kind: "import", items: undoItems, created }),
    }).returning({ id: bulkOps.id }).get();
    pruneOps(tx, now);
    return {
      opId: op.id, summary, added: created.length, updated: undoItems.length,
      skipped: c.problems + p.outcomes.filter((o) => o.type === "duplicate_skipped").length,
      addedItems, updatedItems,
    };
  }, { behavior: "immediate" });
  if (!("error" in result)) refreshGuideQuietly(touched, db, now);
  return result;
}
