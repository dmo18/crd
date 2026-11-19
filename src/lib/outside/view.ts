import { count, eq, sum } from "drizzle-orm";
import type { Db } from "@/db";
import { outsideCache } from "@/db/schema";
import { gateFor } from "./gate";
import { keyStatus } from "./keys";
import { availableSources, SOURCES, type SourceId } from "./sources";
import { getSourceState, usageDays, utcDay, type UsageDay } from "./usage";

/**
 * Everything More, Connections shows about one source, in plain values the
 * screen can render. Never a key: for a saved key only its last 4 characters,
 * which the design shows ("Saved, ends in ...4f2a"). Times are ms numbers so
 * the browser can show them in the phone's own time zone.
 */

export type ConnectionState =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "paused"; untilMs: number; reason: string }
  | { kind: "needs_key" }
  | { kind: "enter_again" };

export type ConnectionKeyView =
  | { state: "none" }
  | { state: "saved"; last4: string; savedAtMs: number; lastTestAtMs: number | null; lastTestOk: boolean | null }
  | { state: "enter_again"; savedAtMs: number };

export type ConnectionView = {
  id: SourceId;
  name: string;
  usedFor: string;
  enabled: boolean;
  state: ConnectionState;
  /** Only for sources that use a key. */
  key: ConnectionKeyView | null;
  usage: {
    callsToday: number;
    perDay: number | null;
    callsThisHour: number;
    perHour: number | null;
    storeHitsToday: number;
    errorsToday: number;
    lastOkAtMs: number | null;
    /** A few plain words from the gate, never a URL or an answer. */
    lastError: string | null;
    /** Last 7 UTC days, newest first. */
    days: Pick<UsageDay, "day" | "calls" | "storeHits" | "errors">[];
  };
  stored: { answers: number; bytes: number };
};

function storedAnswers(db: Db, source: SourceId): { answers: number; bytes: number } {
  const row = db.select({ n: count(), bytes: sum(outsideCache.bytes) }).from(outsideCache)
    .where(eq(outsideCache.source, source)).get();
  return { answers: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export function connectionView(db: Db, source: SourceId, nowMs = Date.now()): ConnectionView {
  const src = SOURCES[source];
  const st = getSourceState(db, source);
  const ks = src.needsKey ? keyStatus(db, source) : null;
  const key: ConnectionKeyView | null = ks === null ? null
    : ks.state === "none" ? { state: "none" }
    : ks.state === "enter_again" ? { state: "enter_again", savedAtMs: ks.savedAt.getTime() }
    : { state: "saved", last4: ks.last4, savedAtMs: ks.savedAt.getTime(), lastTestAtMs: ks.lastTestAt?.getTime() ?? null, lastTestOk: ks.lastTestOk };

  let state: ConnectionState;
  if (!st.enabled) state = { kind: "off" };
  else if (st.pausedUntil && st.pausedUntil.getTime() > nowMs) {
    state = { kind: "paused", untilMs: st.pausedUntil.getTime(), reason: st.lastError ?? "The site asked us to slow down" };
  } else if (ks?.state === "none") state = { kind: "needs_key" };
  else if (ks?.state === "enter_again") state = { kind: "enter_again" };
  else state = { kind: "on" };

  const days = usageDays(db, source, nowMs, 7);
  const today = days.find((d) => d.day === utcDay(nowMs));
  return {
    id: source,
    name: src.name,
    usedFor: src.usedFor,
    enabled: st.enabled,
    state,
    key,
    usage: {
      callsToday: today?.calls ?? 0,
      perDay: src.perDay,
      callsThisHour: gateFor(db).callsThisHour(source),
      perHour: src.perHour,
      storeHitsToday: today?.storeHits ?? 0,
      errorsToday: today?.errors ?? 0,
      lastOkAtMs: st.lastOkAt?.getTime() ?? null,
      lastError: st.lastError,
      days: days.map((d) => ({ day: d.day, calls: d.calls, storeHits: d.storeHits, errors: d.errors })),
    },
    stored: storedAnswers(db, source),
  };
}

/** All sources that exist here (the demo source only outside production). */
export function connectionsView(db: Db, nowMs = Date.now()): ConnectionView[] {
  return availableSources().map((id) => connectionView(db, id, nowMs));
}
