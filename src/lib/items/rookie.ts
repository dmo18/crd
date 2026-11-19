import { z } from "zod";
import type { ReadEvidence } from "@/lib/recognition/types";
import { ROOKIE_SOURCES, ROOKIE_STATES, type Item, type RookieSource, type RookieState } from "@/db/schema";

/**
 * The rookie mark. `rookieState` holds the answer and `isRookie` stays true
 * exactly when it is `yes`, so the Rookies filter, bulk edit and the export
 * keep working. Every write goes through withRookie(), which sets both.
 * A null state is an item from before Milestone 11: it shows "Rookie card:
 * yes" or nothing, as before, with "Source not recorded".
 *
 * The app suggests, the owner chooses. A scan writes the mark only for a key
 * card list hit (source `key_list`, the fixed note below). A read ROOKIE word
 * is kept as a note with no state (source `reading`), so it is only a question.
 * The owner's answer (source `owner`) is never changed again by the app.
 */

export const ROOKIE_NOTE_MAX = 200;

export const ROOKIE_STATE_LABELS: Record<RookieState, string> = {
  yes: "Yes", no: "No", unknown: "Not sure", disputed: "Disputed",
};

export const rookieStateSchema = z.enum(ROOKIE_STATES);
export const rookieSourceSchema = z.enum(ROOKIE_SOURCES);

export type RookieColumns = Pick<Item, "isRookie" | "rookieState" | "rookieSource" | "rookieNote">;

/** The four columns for one rookie answer. The note is trimmed and cut to 200 characters. */
export function withRookie(state: RookieState, source: RookieSource, note?: string | null): RookieColumns {
  const n = (note ?? "").trim().slice(0, ROOKIE_NOTE_MAX).trim();
  return { isRookie: state === "yes", rookieState: rookieStateSchema.parse(state), rookieSource: rookieSourceSchema.parse(source), rookieNote: n === "" ? null : n };
}

export type RookieView = {
  /** The state to show. Null when nothing is recorded and the old mark is off (show nothing). */
  state: RookieState | null;
  source: RookieSource | null;
  note: string | null;
  /** False for an old item whose mark has no recorded source. */
  sourceRecorded: boolean;
};

/** Reads the rookie mark of any item, old or new. Never writes. */
export function readRookie(item: Pick<Item, "isRookie" | "rookieState" | "rookieSource" | "rookieNote">): RookieView {
  const state = rookieStateSchema.safeParse(item.rookieState);
  if (state.success) {
    const source = rookieSourceSchema.safeParse(item.rookieSource);
    return { state: state.data, source: source.success ? source.data : null, note: item.rookieNote ?? null, sourceRecorded: source.success };
  }
  // No state yet, but a scan may have kept what it read as a question (source `reading`, a note, state empty).
  if (!item.isRookie) {
    const source = rookieSourceSchema.safeParse(item.rookieSource);
    if (source.success) return { state: null, source: source.data, note: item.rookieNote ?? null, sourceRecorded: true };
  }
  return { state: item.isRookie ? "yes" : null, source: null, note: null, sourceRecorded: false };
}

// ---------------------------------------------------------------------------
// Evidence and what a scan writes

/** The fixed note of a key list hit. */
export const KEY_LIST_NOTE = "On the built-in key card list";
export const KEY_LIST_REPRINT_NOTE = "On the built-in key card list, but the card says REPRINT, so it is a later copy";
export const ROOKIE_WORD_NOTE = "The word ROOKIE is on the card. That alone does not make it the rookie card (it may be an All-Star Rookie cup or a Rated Rookie of a later year)";
export const AI_ROOKIE_NOTE = "The AI reader thinks this is a rookie card. Check it before relying on it";

export type EvidenceLine = { text: string; source: "key_list" | "catalog" | "reading" };
export type RookieEvidence = { lines: EvidenceLine[]; suggested: RookieState | null };

/**
 * What is known about the rookie mark of a card, in plain words, and the one
 * answer that follows. Pure; the screens show the lines and the owner taps.
 * - Key list says yes, catalog tag RC agrees: yes. Key list alone: yes or no.
 * - Key list and the catalog tag disagree: disputed, both lines.
 * - The catalog tag alone: yes. The word ROOKIE or RC alone: not sure.
 * - Nothing at all: no lines and no suggestion.
 * The read word never turns a key list "no" into anything else.
 */
export function rookieEvidence(input: {
  keyCard?: { isRookie: boolean; note?: string | null } | null;
  catalogTags?: readonly string[] | null;
  readWord?: boolean;
  reprint?: boolean;
}): RookieEvidence {
  const lines: EvidenceLine[] = [];
  const key = input.keyCard ?? null;
  const catalogYes = (input.catalogTags ?? []).some((t) => t.toUpperCase() === "RC");
  const keyNote = (yes: boolean) => {
    const what = yes ? "The built-in key card list says this is a rookie card" : "The built-in key card list says this is not the rookie card";
    const extra = input.keyCard?.note?.trim();
    return extra ? `${what}: ${extra}` : what;
  };
  if (key) lines.push({ text: input.reprint ? KEY_LIST_REPRINT_NOTE : keyNote(key.isRookie), source: "key_list" });
  if (catalogYes) lines.push({ text: "The catalog marks this card RC (rookie card). From MyCardfolio", source: "catalog" });
  if (input.readWord) lines.push({ text: ROOKIE_WORD_NOTE, source: "reading" });

  let suggested: RookieState | null = null;
  if (key) {
    if (input.reprint && key.isRookie) suggested = "unknown";
    else if (key.isRookie) suggested = "yes";
    else suggested = catalogYes ? "disputed" : "no";
  } else if (catalogYes) suggested = "yes";
  else if (input.readWord) suggested = "unknown";
  return { lines, suggested };
}

/**
 * The rookie columns a scan writes. Only a key card list hit writes a state,
 * with source `key_list` and the fixed note; a reprint is "not sure" instead of
 * "yes". A read word, or a paid reader's yes, is kept as a note with no state
 * (source `reading`): `isRookie` stays false until the owner taps.
 */
export function rookieFromScan(isCard: boolean, readerSaysRookie: boolean, evidence: ReadEvidence | undefined): RookieColumns {
  const none: RookieColumns = { isRookie: false, rookieState: null, rookieSource: null, rookieNote: null };
  if (!isCard) return none;
  const key = evidence?.keyCard;
  if (key) {
    if (evidence?.reprint && key.isRookie) return withRookie("unknown", "key_list", KEY_LIST_REPRINT_NOTE);
    return withRookie(key.isRookie ? "yes" : "no", "key_list", KEY_LIST_NOTE);
  }
  if (evidence?.rookieWord) return { ...none, rookieSource: "reading", rookieNote: ROOKIE_WORD_NOTE };
  if (readerSaysRookie) return { ...none, rookieSource: "reading", rookieNote: AI_ROOKIE_NOTE };
  return none;
}

/** What the "Rookie card?" question shows for an item, or null when it asks nothing. */
export type RookieAsk = { lines: string[]; suggested: RookieState | null; current: RookieState | null };

export function rookieAsk(
  item: Pick<Item, "kind" | "isRookie" | "rookieState" | "rookieSource" | "rookieNote" | "rarityNotes">,
  catalogTags: readonly string[] = [],
): RookieAsk | null {
  if (item.kind !== "card") return null;
  const view = readRookie(item);
  // The owner's answer is final. An old item with no recorded mark asks nothing.
  if (view.source === "owner") return null;
  const keyHit = view.source === "key_list" && (view.state === "yes" || view.state === "no" || view.state === "unknown");
  const readNote = view.state === null && view.source === "reading" ? view.note : null;
  const reprint = keyHit && view.state === "unknown";
  const ev = rookieEvidence({
    keyCard: keyHit ? { isRookie: view.state === "yes" || reprint, note: item.rarityNotes } : null,
    catalogTags,
    readWord: readNote === ROOKIE_WORD_NOTE,
    reprint,
  });
  const lines = ev.lines.map((l) => l.text);
  if (readNote != null && readNote !== ROOKIE_WORD_NOTE) lines.push(readNote);
  if (lines.length === 0) return null;
  return { lines, suggested: ev.suggested ?? (readNote ? "unknown" : null), current: view.state };
}
