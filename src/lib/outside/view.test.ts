import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { putCached } from "./cache";
import { saveKey } from "./keys";
import { bumpUsage, pauseSource, recordError, recordOk, setSourceEnabled } from "./usage";
import { connectionsView, connectionView } from "./view";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const KEY = "demo_Key-0123456789abcdefXYZ4f2a";

describe("the usage view", () => {
  it("shows today against the caps, the 7 day list with quiet days, stored answers and the last good call", () => {
    const db = createDb(":memory:");
    bumpUsage(db, "mycardfolio", NOW, { calls: 12, storeHits: 5, errors: 1 });
    bumpUsage(db, "mycardfolio", NOW - 2 * DAY, { calls: 7 });
    bumpUsage(db, "mycardfolio", NOW - 9 * DAY, { calls: 99 });
    bumpUsage(db, "wikidata", NOW, { calls: 3 });
    recordOk(db, "mycardfolio", NOW - 60_000);
    recordError(db, "mycardfolio", "The site did not answer in time.", NOW - 30_000);
    putCached(db, { key: "k1", source: "mycardfolio", kind: "search", body: "abcd", nowMs: NOW });
    const v = connectionView(db, "mycardfolio", NOW);
    expect(v.state).toEqual({ kind: "on" });
    expect(v.key).toBeNull();
    expect(v.usage).toMatchObject({
      callsToday: 12, perDay: 1000, perHour: 200, callsThisHour: 0, storeHitsToday: 5, errorsToday: 1,
      lastOkAtMs: NOW - 60_000, lastError: "The site did not answer in time.",
    });
    expect(v.usage.days.map((d) => [d.day, d.calls])).toEqual([
      ["2026-11-16", 12], ["2026-11-15", 0], ["2026-11-14", 7], ["2026-11-13", 0],
      ["2026-11-12", 0], ["2026-11-11", 0], ["2026-11-10", 0],
    ]);
    expect(v.stored).toEqual({ answers: 1, bytes: 4 });
    expect(connectionView(db, "wikidata", NOW).usage).toMatchObject({ callsToday: 3, perDay: null, perHour: null });
  });

  it("gives each state: off, paused (until a time), needs a key, enter again", () => {
    const db = createDb(":memory:");
    setSourceEnabled(db, "mycardfolio", false, NOW);
    expect(connectionView(db, "mycardfolio", NOW).state).toEqual({ kind: "off" });
    pauseSource(db, "wikidata", NOW + 600_000, "The site asked us to slow down", NOW);
    expect(connectionView(db, "wikidata", NOW).state).toEqual({ kind: "paused", untilMs: NOW + 600_000, reason: "The site asked us to slow down" });
    expect(connectionView(db, "wikidata", NOW + 600_001).state).toEqual({ kind: "on" });
    expect(connectionView(db, "demo", NOW)).toMatchObject({ state: { kind: "needs_key" }, key: { state: "none" } });
    saveKey(db, "demo", KEY, new Date(NOW), "settings-key-for-tests-only-0123456789");
    expect(connectionView(db, "demo", NOW)).toMatchObject({ state: { kind: "enter_again" }, key: { state: "enter_again", savedAtMs: NOW } });
    saveKey(db, "demo", KEY, new Date(NOW));
    const v = connectionView(db, "demo", NOW);
    expect(v).toMatchObject({ state: { kind: "on" }, key: { state: "saved", last4: "4f2a", savedAtMs: NOW, lastTestAtMs: null } });
    expect(JSON.stringify(v)).not.toContain(KEY);
  });

  it("lists the demo source only outside production", () => {
    const db = createDb(":memory:");
    expect(connectionsView(db, NOW).map((v) => v.id)).toEqual(["mycardfolio", "wikidata", "demo"]);
  });
});
