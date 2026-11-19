import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, playerFacts, valuations, type Item } from "@/db/schema";
import { collectionTotals, valueSplit } from "../snapshots";
import { fillGuidePrices, GUIDE_MESSAGES, refreshGuidePrice } from "./apply";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });
const NOW = new Date("2026-11-19T12:00:00Z");

function add(values: Partial<Item> = {}): Item {
  return db.insert(items).values({ kind: "card", title: "Test card", ...values }).returning().get();
}
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
const history = (id: number) => db.select().from(valuations).where(eq(valuations.itemId, id)).all();

describe("saving guide prices", () => {
  it("fills items without a value, once, with a history row", () => {
    const a = add({ year: 1990, brand: "Donruss", player: "Joe Nobody", cardNumber: "5" });
    expect(fillGuidePrices(db, NOW)).toBe(1);
    const row = get(a.id);
    expect(row.valueSource).toBe("price_guide");
    expect(row.estLowCents).toBe(1);
    expect(row.estHighCents).toBe(25);
    expect(row.valueBasis).toMatch(/^Trust: Low\. Common card from 1990/);
    expect(row.valuedAt?.getTime()).toBe(NOW.getTime());
    expect(history(a.id)).toHaveLength(1);
    // Running again changes nothing.
    expect(fillGuidePrices(db, new Date(NOW.getTime() + 1000))).toBe(0);
    expect(history(a.id)).toHaveLength(1);
  });

  it("never touches the owner's value or another source's estimate", () => {
    const own = add({ year: 1990, brand: "Donruss", player: "Joe", cardNumber: "5", manualValueCents: 1234 });
    const other = add({ year: 1990, brand: "Donruss", player: "Joe", cardNumber: "6", estValueCents: 300, valueSource: "ai_estimate" });
    expect(fillGuidePrices(db, NOW)).toBe(0);
    expect(get(own.id)).toMatchObject({ manualValueCents: 1234, estValueCents: null, valueSource: null });
    expect(get(other.id)).toMatchObject({ estValueCents: 300, valueSource: "ai_estimate" });
    expect(refreshGuidePrice(own.id, db, NOW)).toEqual({ ok: false, error: GUIDE_MESSAGES.ownValue });
    expect(refreshGuidePrice(other.id, db, NOW)).toEqual({ ok: false, error: GUIDE_MESSAGES.otherSource });
  });

  it("updates when fields change and clears a guide value that no longer applies", () => {
    const a = add({ year: 1989, brand: "Upper Deck", player: "Ken Griffey Jr.", cardNumber: "1" });
    refreshGuidePrice(a.id, db, NOW);
    expect(get(a.id).estLowCents).toBe(4000);
    db.update(items).set({ cardNumber: "999", player: "Joe Nobody" }).where(eq(items.id, a.id)).run();
    refreshGuidePrice(a.id, db, NOW);
    expect(get(a.id).estHighCents).toBeLessThan(100);
    expect(history(a.id)).toHaveLength(2);
    db.update(items).set({ year: null }).where(eq(items.id, a.id)).run();
    const r = refreshGuidePrice(a.id, db, NOW);
    expect(r.ok && !r.price.ok && r.price.missing).toMatch(/add the year/);
    expect(get(a.id)).toMatchObject({ estValueCents: null, estLowCents: null, valueSource: null, valueBasis: null });
  });

  it("uses a stored Wikidata Hall of Fame fact, without calling out", () => {
    const facts = [{
      name: "Joe Famous", wikidataId: "Q1", description: "baseball player", sports: ["baseball"], teams: [],
      careerStart: 1980, careerEnd: 1995, hallOfFame: true, birthYear: 1960,
    }];
    db.insert(playerFacts).values({ key: "joe famous|baseball", facts: JSON.stringify(facts), fetchedAt: NOW }).run();
    const a = add({ year: 1990, brand: "Fleer", player: "Joe Famous", cardNumber: "5", sport: "baseball" });
    const b = add({ year: 1990, brand: "Fleer", player: "Joe Unknown", cardNumber: "6", sport: "baseball" });
    fillGuidePrices(db, NOW);
    expect(get(a.id).valueBasis).toMatch(/Hall of Fame player/);
    expect(get(a.id).estHighCents!).toBeGreaterThan(get(b.id).estHighCents!);
  });

  it("splits the Home total into the owner's values, guide values and other estimates", () => {
    add({ year: 1989, brand: "Upper Deck", player: "Ken Griffey Jr.", cardNumber: "1", quantity: 2 });
    add({ year: 1990, brand: "Donruss", player: "Joe", cardNumber: "5", manualValueCents: 1000, quantity: 3 });
    add({ estValueCents: 700, valueSource: "ai_estimate" });
    add({ estValueCents: 999, valueSource: "price_guide", manualValueCents: 50 });
    add({ estValueCents: 4000, valueSource: "price_guide", deletedAt: NOW });
    fillGuidePrices(db, NOW);
    const guideEach = get(1).estValueCents!;
    expect(guideEach).toBeGreaterThan(4000);
    const split = valueSplit(db);
    expect(split).toEqual({ ownCents: 3050, guideCents: guideEach * 2, otherCents: 700 });
    expect(split.ownCents + split.guideCents + split.otherCents).toBe(collectionTotals(db).totalValueCents);
  });

  it("leaves items in Recently deleted alone", () => {
    const a = add({ year: 1990, brand: "Donruss", player: "Joe", cardNumber: "5", deletedAt: NOW });
    expect(fillGuidePrices(db, NOW)).toBe(0);
    expect(refreshGuidePrice(a.id, db, NOW)).toEqual({ ok: false, error: GUIDE_MESSAGES.missing });
  });
});
