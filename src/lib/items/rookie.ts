import { z } from "zod";
import { ROOKIE_SOURCES, ROOKIE_STATES, type Item, type RookieSource, type RookieState } from "@/db/schema";

/**
 * The rookie mark. `rookieState` holds the answer and `isRookie` stays true
 * exactly when it is `yes`, so the Rookies filter, bulk edit and the export
 * keep working. Every write goes through withRookie(), which sets both.
 * A null state is an item from before Milestone 11: it shows "Rookie card:
 * yes" or nothing, as before, with "Source not recorded".
 * (The evidence part, rookieEvidence(), comes in task 11.4.)
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
  return { state: item.isRookie ? "yes" : null, source: null, note: null, sourceRecorded: false };
}
