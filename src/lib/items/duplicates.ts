import { and, asc, count, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { images, items, valuations, type Item } from "@/db/schema";
import { normalizeBrand, normalizeName, normalizeText, printedCardNumber } from "@/lib/catalog/normalize";
import { liveItem } from "./live";
import { scrubUndo } from "./undo-scrub";
import { removeItemRows } from "./remove";
import { formatSerial, splitSerial } from "./serial";
import { withRookie } from "./rookie";
import { buildTitle } from "@/lib/title";

/**
 * Possible duplicates (PLAN.md Milestone 11, "Design: duplicates"). The app
 * only asks; nothing here combines two records without the owner's tap.
 *
 * - `same`: the same card, version, grade and no serial copy on either.
 * - `maybe`: the same card, but the version or the grade is open or differs
 *   in a way that may be a mistake. Never combined.
 * - `same_numbered`: the very same numbered card (same copy and print run)
 *   entered twice. Combining removes the double entry without raising the quantity.
 */
export const DUPLICATE_KINDS = ["same", "maybe", "same_numbered"] as const;
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];
export type DuplicateMatch = { item: Item; kind: DuplicateKind };

/** Most ids one item remembers as "kept apart"; the oldest goes first when full. */
export const MAX_KEPT_APART = 50;

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

const keptApartSchema = z.array(z.number().int().positive()).max(MAX_KEPT_APART);

/** The ids this item was kept apart from. A broken stored value counts as none. */
export function keptApartIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const r = keptApartSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/** The stored list with `otherId` added (once), keeping at most MAX_KEPT_APART, newest last. */
export function withKeptApart(raw: string | null | undefined, otherId: number): string {
  const list = keptApartIds(raw).filter((id) => id !== otherId);
  list.push(otherId);
  return JSON.stringify(list.slice(-MAX_KEPT_APART));
}

/** The columns the duplicate rule reads. The filter selects only these: reading whole rows of 5,000 items is the slow part. */
const DUP_KEYS = [
  "id", "kind", "status", "catalogCardId", "year", "brand", "setName", "cardNumber", "player", "sport", "productType",
  "variation", "versionState", "grader", "grade", "serialCopy", "serialEdition", "serialNumber", "keptApartFrom",
] as const;
type DupKey = (typeof DUP_KEYS)[number];
// Read only: these columns are selected, never written.
const DUP_COLUMNS = Object.fromEntries(DUP_KEYS.map((k) => [k, items[k]])) as { [K in DupKey]: (typeof items)[K] };
type DupRow = Pick<Item, DupKey>;

/** Sealed products: the fields of today, all equal. */
function sealedKey(item: DupRow): string | null {
  const hasWhen = item.year != null || norm(item.brand) !== "";
  const hasWhat = item.productType != null || norm(item.setName) !== "";
  if (!hasWhen || !hasWhat) return null;
  return JSON.stringify([item.year, item.brand, item.setName, item.sport, item.productType].map((v) => (v == null ? "" : norm(String(v)))));
}

/** What card, from the fields of today, spelled-out differences removed ("Ken Griffey Jr" and "Jr." meet). */
function cardFieldsKey(item: DupRow): string | null {
  const hasWho = norm(item.player) !== "" || norm(item.cardNumber) !== "";
  const hasWhen = item.year != null || norm(item.brand) !== "";
  if (!hasWho || !hasWhen) return null;
  // Joined with a character none of the normalized parts can hold.
  return [
    item.year ?? "",
    normalizeBrand(item.brand ?? ""),
    normalizeText(item.setName ?? ""),
    printedCardNumber(item.cardNumber ?? ""),
    normalizeName(item.player ?? ""),
  ].join("|");
}

/** Player and card number, for pairs whose other fields are partly blank. */
function whoKey(item: DupRow): string | null {
  const who = normalizeName(item.player ?? "");
  const num = printedCardNumber(item.cardNumber ?? "");
  return who && num ? `${who}|${num}` : null;
}

/**
 * The same player and card number, and year, brand, set and sport each the
 * same or blank on one side ("Possible duplicates" for a card read without
 * its year or brand).
 */
function sameWithBlanks(a: DupRow, b: DupRow): boolean {
  const fits = (x: string, y: string) => x === "" || y === "" || x === y;
  const k = whoKey(a);
  if (!k || k !== whoKey(b)) return sameButNumber(a, b) && fits(normalizeText(a.setName ?? ""), normalizeText(b.setName ?? "")) && fits(a.sport ?? "", b.sport ?? "");
  return fits(a.year == null ? "" : String(a.year), b.year == null ? "" : String(b.year))
    && fits(normalizeBrand(a.brand ?? ""), normalizeBrand(b.brand ?? ""))
    && fits(normalizeText(a.setName ?? ""), normalizeText(b.setName ?? ""))
    && fits(a.sport ?? "", b.sport ?? "");
}

/** Player, year and brand, for a card whose number is blank on one side. */
function whenKey(item: DupRow): string | null {
  const who = normalizeName(item.player ?? "");
  const brand = normalizeBrand(item.brand ?? "");
  return who && item.year != null && brand ? `${who}|${item.year}|${brand}` : null;
}

/**
 * The same player, year and brand, with the card number blank on exactly
 * one side (a number cut off by the photo's edge): only a question.
 */
function sameButNumber(a: DupRow, b: DupRow): boolean {
  const k = whenKey(a);
  if (!k || k !== whenKey(b)) return false;
  const na = printedCardNumber(a.cardNumber ?? "");
  const nb = printedCardNumber(b.cardNumber ?? "");
  return (na === "") !== (nb === "");
}

const UNGRADED = JSON.stringify(["", ""]);

type Side = {
  item: DupRow;
  sealed: string | null;
  fields: string | null;
  version: string;
  grade: string;
  copy: number | null;
  edition: number | null;
  apart: Set<number> | null;
};

/** The two parts when saved; else an old whole text that splits ("045/100"). */
function rawSerial(item: DupRow): { copy: string | null; edition: string | null } | null {
  return item.serialCopy != null || item.serialEdition != null
    ? { copy: item.serialCopy, edition: item.serialEdition }
    : splitSerial(item.serialNumber);
}

function serialParts(item: DupRow): { copy: number | null; edition: number | null } {
  const parts = rawSerial(item);
  const num = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return { copy: num(parts?.copy), edition: num(parts?.edition) };
}

function sideOf(item: DupRow): Side {
  const variation = normalizeText(item.variation ?? "");
  const { copy, edition } = serialParts(item);
  return {
    item,
    sealed: item.kind === "sealed" ? sealedKey(item) : null,
    fields: item.kind === "card" ? cardFieldsKey(item) : null,
    // "Base" is the normal card, the same as no version name.
    version: variation === "base" ? "" : variation,
    grade: item.grader == null && item.grade == null ? UNGRADED : JSON.stringify([norm(item.grader), norm(item.grade)]),
    copy,
    edition,
    apart: item.keptApartFrom ? new Set(keptApartIds(item.keptApartFrom)) : null,
  };
}

/**
 * The kind of duplicate two items are, or null when they are not
 * duplicates. Order of the checks as the plan: what card, version, grader
 * and grade, serial. A pair the owner kept apart is never asked again.
 */
function classify(a: Side, b: Side, opts: { ignoreApart?: boolean } = {}): DuplicateKind | null {
  if (a.item.id === b.item.id || a.item.kind !== b.item.kind) return null;
  if (!opts.ignoreApart && (a.apart?.has(b.item.id) || b.apart?.has(a.item.id))) return null;
  if (a.item.kind === "sealed") return a.sealed !== null && a.sealed === b.sealed ? "same" : null;
  if (a.item.kind !== "card") return null;

  let loose = false;
  // 1. What card: the catalog card when both have one (two different ones are never duplicates).
  const ca = a.item.catalogCardId;
  const cb = b.item.catalogCardId;
  if (ca != null && cb != null) {
    if (ca !== cb) return null;
  } else if (a.fields === null || a.fields !== b.fields) {
    // The same player and number with nothing that contradicts (a blank is no contradiction): only a question.
    if (!sameWithBlanks(a.item, b.item)) return null;
    loose = true;
  }

  // 4 first, as a hard stop: two different numbered copies are each their own card.
  if (a.copy != null && b.copy != null && a.copy !== b.copy) return null;
  if (a.edition != null && b.edition != null && a.edition !== b.edition) return null;

  // 3. Grader and grade: two different grades are two cards; one empty is a question.
  let gradeOpen = false;
  if (a.grade !== b.grade) {
    if (a.grade !== UNGRADED && b.grade !== UNGRADED) return null;
    gradeOpen = true;
  }

  // 2. Version.
  const sa = a.item.versionState;
  const sb = b.item.versionState;
  let versionOpen = false;
  if (a.version === b.version) {
    // Equal only when both are confirmed or both never asked.
    versionOpen = sa !== sb || sa === "not_sure";
  } else {
    const noVersion = (s: Side) => s.version === "" && s.item.versionState == null;
    if (sa === "not_sure" || sb === "not_sure" || noVersion(a) || noVersion(b)) versionOpen = true;
    else return null;
  }

  const open = versionOpen || gradeOpen || loose;
  if (a.copy != null && b.copy != null) return open ? "maybe" : "same_numbered";
  // A serial copy on one side only: may be the same card with the number not typed in.
  if (a.copy != null || b.copy != null) return "maybe";
  return open ? "maybe" : "same";
}

/**
 * Live items that may be the same card (or sealed product) as this one:
 * confirmed ones first. For an item still in Review, then also the other
 * items still in Review (the same card scanned twice before either was
 * confirmed): always only a `maybe`, so never combined by itself. A
 * confirmed item is only compared with confirmed ones, as before. Lowest id
 * first within each.
 */
export function findDuplicateMatches(itemId: number, db: Db = getDb(), opts: { ignoreApart?: boolean; againstAll?: boolean } = {}): DuplicateMatch[] {
  const item = db.select().from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (!item || (item.kind !== "card" && item.kind !== "sealed")) return [];
  const me = sideOf(item);
  const sameYear = item.year == null ? isNull(items.year) : eq(items.year, item.year);
  const candidates = db.select().from(items)
    .where(and(
      liveItem,
      eq(items.kind, item.kind),
      item.status === "confirmed" && !opts.againstAll ? eq(items.status, "confirmed") : undefined,
      ne(items.id, item.id),
      or(
        sameYear,
        item.catalogCardId != null ? eq(items.catalogCardId, item.catalogCardId) : undefined,
        // Same player and number with a blank year on one side (sameWithBlanks decides).
        whoKey(item) ? (item.year == null ? isNotNull(items.cardNumber) : isNull(items.year)) : undefined,
      ),
    ))
    .orderBy(asc(items.id)).all();
  const confirmed: DuplicateMatch[] = [];
  const waiting: DuplicateMatch[] = [];
  for (const c of candidates) {
    const kind = classify(me, sideOf(c), opts);
    if (!kind) continue;
    if (c.status === "confirmed") confirmed.push({ item: c, kind });
    else waiting.push({ item: c, kind: "maybe" });
  }
  return [...confirmed, ...waiting];
}

/**
 * A card just read (a scan of any kind, or the app's own catalog link) is
 * never filed by itself when it may be a card already in the collection:
 * compared with every live item, confirmed or in Review, by the duplicate
 * rule, and when one matches it goes back to Review ("Needs a look", "May be
 * a card you already have"). Items the owner kept apart do not count. True
 * when the item was held. Runs inside the caller's transaction.
 */
export function holdIfDuplicate(itemId: number, db: Db): boolean {
  const item = db.select({ status: items.status }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
  if (item?.status !== "confirmed") return false;
  if (findDuplicateMatches(itemId, db, { againstAll: true }).length === 0) return false;
  db.update(items).set({ status: "needs_review" }).where(eq(items.id, itemId)).run();
  return true;
}

/** The items only, for callers that do not need the kind. */
export function findDuplicates(itemId: number, db: Db = getDb()): Item[] {
  return findDuplicateMatches(itemId, db).map((m) => m.item);
}

/** "045/100" for the notice of a same numbered pair. */
export function serialText(item: Item): string | null {
  const parts = rawSerial(item);
  if (!parts?.copy || !parts.edition) return null;
  return formatSerial(parts.copy, parts.edition);
}

/**
 * Ids of live items that have at least one possible duplicate (any of the
 * three kinds), by the same rule as findDuplicateMatches: an item in
 * Review meets confirmed ones and other ones in Review, a confirmed item
 * only confirmed ones; kept apart pairs are left out. For the "Possible
 * duplicates" filter. Lowest id first.
 */
export function duplicateIds(db: Db = getDb()): number[] {
  const rows = db.select(DUP_COLUMNS).from(items).where(and(liveItem, inArray(items.kind, ["card", "sealed"]))).all();
  // Pairs can only meet inside a group with the same fields, or the same catalog card.
  const groups = new Map<string, Side[]>();
  const put = (key: string, s: Side) => {
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  };
  for (const row of rows) {
    const s = sideOf(row);
    if (s.sealed) put(`s${s.sealed}`, s);
    if (s.fields) put(`f${s.fields}`, s);
    if (row.kind === "card") {
      const who = whoKey(row);
      if (who) put(`w${who}`, s);
      const when = whenKey(row);
      if (when) put(`p${when}`, s);
    }
    if (row.kind === "card" && row.catalogCardId != null) put(`c${row.catalogCardId}`, s);
  }
  const out = new Set<number>();
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!classify(a, b)) continue;
        const aConfirmed = a.item.status === "confirmed";
        const bConfirmed = b.item.status === "confirmed";
        // Each side counts when the other is one it is compared with.
        if (bConfirmed || !aConfirmed) out.add(a.item.id);
        if (aConfirmed || !bConfirmed) out.add(b.item.id);
      }
    }
  }
  return [...out].sort((x, y) => x - y);
}

export const MERGE_PROBLEMS = ["not_same", "gone", "too_many", "maybe"] as const;
export type MergeProblem = (typeof MERGE_PROBLEMS)[number];
export type MergeResult = { ok: true; targetId: number; movedPhotos: number } | { ok: false; error: string; problem: MergeProblem };

/** Largest quantity the item form accepts; a merge never goes above it. */
export const MAX_QUANTITY = 100_000;

export const MERGE_MESSAGES: Record<MergeProblem, string> = {
  not_same: "These are not the same card.",
  gone: "That item no longer exists.",
  too_many: `Together these come to more than ${MAX_QUANTITY.toLocaleString("en-US")}, the most one item can hold. Change the quantity by hand instead.`,
  maybe: "These may not be the same card, so they were not combined. Open the old one and check the version and grade first.",
};

const refuse = (problem: MergeProblem) => ({ ok: false, error: MERGE_MESSAGES[problem], problem }) as const;

/** Value fields copied from the source when the target has no value of its own. */
const VALUE_FIELDS = ["estLowCents", "estHighCents", "estValueCents", "valueSource", "valueBasis", "valuedAt", "manualValueCents"] as const;

/** Thrown inside the transaction to roll it back if a combine would ever delete a photo. */
class PhotoWouldBeDeleted extends Error {}

/**
 * Fold the source into the target, in one transaction. Only for `same`
 * (quantities add up) and `same_numbered` (a double entry: the quantity
 * stays). Refused for `maybe` and for anything that is not a duplicate,
 * whatever a form sends. The older record is always the target and keeps its own fields (version,
 * rookie mark, own value and notes of the newer one come over only where the
 * older has none); when it has no
 * value at all it takes the source's value and history. The source's
 * photos, with their kept originals, MOVE to the target: a combine never
 * deletes a photo. Then the source is removed for good (not the bin: its
 * count now lives in the target, so a restore would count it twice).
 */
export function mergeInto(askedSourceId: number, askedTargetId: number, db: Db = getDb()): MergeResult {
  if (askedSourceId === askedTargetId) return refuse("not_same");
  // The older record (lower id) is always the one kept, whichever page the owner started from.
  const targetId = Math.min(askedSourceId, askedTargetId);
  const sourceId = Math.max(askedSourceId, askedTargetId);
  try {
    return db.transaction((tx): MergeResult => {
      const t = tx as unknown as Db;
      // An item in Recently deleted cannot take part in a merge.
      const source = tx.select().from(items).where(and(eq(items.id, sourceId), liveItem)).get();
      const target = tx.select().from(items).where(and(eq(items.id, targetId), liveItem)).get();
      if (!source || !target) return refuse("gone");
      // Asked the way the owner named the pair: the other record must be a confirmed one.
      const match = findDuplicateMatches(askedSourceId, t).find((d) => d.item.id === askedTargetId);
      if (!match) return refuse("not_same");
      if (match.kind === "maybe") return refuse("maybe");
      const quantity = match.kind === "same_numbered" ? target.quantity : target.quantity + source.quantity;
      if (quantity > MAX_QUANTITY) return refuse("too_many");

      const patch: Partial<Item> = { quantity, updatedAt: new Date() };
      const targetHasValue = target.manualValueCents != null || target.estValueCents != null;
      const sourceHasValue = source.manualValueCents != null || source.estValueCents != null;
      const takeValue = !targetHasValue && sourceHasValue;
      if (takeValue) {
        for (const key of VALUE_FIELDS) (patch as Record<string, unknown>)[key] = source[key];
      }
      // Answers the owner gave on the newer record are kept only where the older one has none.
      if (target.manualValueCents == null && source.manualValueCents != null) patch.manualValueCents = source.manualValueCents;
      if (target.versionState == null && source.versionState != null) {
        patch.variation = source.variation;
        patch.versionState = source.versionState;
        patch.versionSource = source.versionSource;
        patch.versionOptions = source.versionOptions;
        patch.title = buildTitle({ ...target, variation: source.variation });
      }
      const noRookie = (s: Item["rookieState"]) => s == null || s === "unknown";
      if (noRookie(target.rookieState) && !noRookie(source.rookieState)) {
        Object.assign(patch, withRookie(source.rookieState!, source.rookieSource ?? "owner", source.rookieNote));
      }
      if (!target.notes?.trim() && source.notes?.trim()) patch.notes = source.notes;
      tx.update(items).set(patch).where(eq(items.id, targetId)).run();
      if (takeValue) tx.update(valuations).set({ itemId: targetId }).where(eq(valuations.itemId, sourceId)).run();

      // The photos move: same rows, same files, same kept originals. They leave
      // the source's scan, so no later clean up of that scan can take them.
      const moved = tx.update(images).set({ itemId: targetId, scanId: null })
        .where(eq(images.itemId, sourceId)).returning({ id: images.id }).all().length;
      // A multi-card scan keeps its whole-sheet photo: when the scan still has
      // photos, the source lets go of it so removing the source leaves the scan.
      if (source.scanId != null) {
        const scanPhotos = tx.select({ n: count() }).from(images).where(eq(images.scanId, source.scanId)).get()?.n ?? 0;
        if (scanPhotos > 0) tx.update(items).set({ scanId: null }).where(eq(items.id, sourceId)).run();
      }
      const files = removeItemRows(t, sourceId) ?? [];
      if (files.length > 0) throw new PhotoWouldBeDeleted();
      scrubUndo(t, [sourceId]);
      return { ok: true, targetId, movedPhotos: moved };
    }, { behavior: "immediate" });
  } catch (e) {
    if (e instanceof PhotoWouldBeDeleted) return refuse("not_same");
    throw e;
  }
}

export type KeepApartResult = { ok: true } | { ok: false; error: string };

/**
 * "Keep both as they are": writes each id into the other's keptApartFrom,
 * so the question does not come back for this pair. Only for a pair that
 * the app would ask about (or already kept apart: then nothing changes).
 */
export function keepApart(aId: number, bId: number, db: Db = getDb()): KeepApartResult {
  if (aId === bId) return { ok: false, error: MERGE_MESSAGES.not_same };
  return db.transaction((tx): KeepApartResult => {
    const t = tx as unknown as Db;
    const a = tx.select().from(items).where(and(eq(items.id, aId), liveItem)).get();
    const b = tx.select().from(items).where(and(eq(items.id, bId), liveItem)).get();
    if (!a || !b) return { ok: false, error: MERGE_MESSAGES.gone };
    const asked = findDuplicateMatches(aId, t, { ignoreApart: true }).some((m) => m.item.id === bId)
      || findDuplicateMatches(bId, t, { ignoreApart: true }).some((m) => m.item.id === aId);
    if (!asked) return { ok: false, error: MERGE_MESSAGES.not_same };
    tx.update(items).set({ keptApartFrom: withKeptApart(a.keptApartFrom, bId) }).where(eq(items.id, aId)).run();
    tx.update(items).set({ keptApartFrom: withKeptApart(b.keptApartFrom, aId) }).where(eq(items.id, bId)).run();
    return { ok: true };
  }, { behavior: "immediate" });
}

/** The review queue, oldest first. */
export function reviewItems(limit: number, db: Db = getDb()): Item[] {
  return db.select().from(items).where(and(liveItem, eq(items.status, "needs_review")))
    .orderBy(asc(items.createdAt), asc(items.id)).limit(limit).all();
}

/** How many items are waiting in the review queue. */
export function reviewCount(db: Db = getDb()): number {
  return db.select({ n: count() }).from(items).where(and(liveItem, eq(items.status, "needs_review"))).get()?.n ?? 0;
}
