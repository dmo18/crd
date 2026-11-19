import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { items, type NewItem } from "@/db/schema";
import { summarize } from "@/lib/scans/view";
import { CHOOSE_VERSION_LINE, shownValue } from "./value-line";

describe("the value line", () => {
  it("Not sure yet hides the estimate and shows the owner's own figure", () => {
    expect(shownValue({ versionState: "not_sure", manualValueCents: null, estValueCents: 900 })).toEqual({ cents: null, waitingForVersion: true, ownersValue: false });
    expect(shownValue({ versionState: "not_sure", manualValueCents: 1200, estValueCents: 900 })).toEqual({ cents: 1200, waitingForVersion: false, ownersValue: true });
  });
  it("never asked (null) and chosen cards show their value as before", () => {
    expect(shownValue({ versionState: null, manualValueCents: null, estValueCents: 900 })).toEqual({ cents: 900, waitingForVersion: false, ownersValue: false });
    expect(shownValue({ versionState: "confirmed", manualValueCents: null, estValueCents: 900 })).toEqual({ cents: 900, waitingForVersion: false, ownersValue: false });
    expect(shownValue({ versionState: null, manualValueCents: null, estValueCents: null })).toEqual({ cents: null, waitingForVersion: false, ownersValue: false });
  });
  it("item rows: no estimate or range for Not sure yet, own figure kept, stored values untouched", () => {
    const db = createDb(":memory:");
    const add = (o: Partial<NewItem>) => db.insert(items).values({ kind: "card", title: "x", estValueCents: 900, estLowCents: 700, estHighCents: 1100, ...o }).returning().get();
    const a = add({ versionState: "not_sure" });
    const b = add({ versionState: "not_sure", manualValueCents: 1500 });
    const c = add({});
    const [ra, rb, rc] = summarize([a, b, c], db);
    expect(ra).toMatchObject({ valueCents: null, lowCents: null, highCents: null, waitingForVersion: true, ownersValue: false });
    expect(rb).toMatchObject({ valueCents: 1500, waitingForVersion: false, ownersValue: true, lowCents: null, highCents: null });
    expect(rc).toMatchObject({ ownersValue: false, valueCents: 900, lowCents: 700, highCents: 1100, waitingForVersion: false });
    expect(a.estValueCents).toBe(900);
    expect(CHOOSE_VERSION_LINE).toBe("Choose the version to see a value");
  });
});
