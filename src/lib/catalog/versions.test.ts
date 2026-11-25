import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { CATALOG_FIELDS, catalogCards, items, type Item, type NewItem } from "@/db/schema";
import { FakeCatalog, recordedSearch } from "../../../tests/helpers/fake-catalog";
import { linkCatalogCard } from "./apply";
import { buildFirstSuggestion } from "./sources";
import { saveCatalogCardIn } from "./store";
import type { CatalogCard } from "./types";
import {
  ANOTHER_NAME, BASE_NAME, buildVersionOptions, chooseVersion, hasSeveralVersions, LIST_CHANGED, loadVersionOptions,
  MAX_VERSION_OPTIONS, NOT_SURE_NAME, parseVersions, resetShowVersionsLimitForTests, SHOW_BUSY, SHOW_EVERY_MS, SHOW_WAIT,
  versionSearches, type VersionItem,
} from "./versions";
import { slimCandidate } from "./candidates";

/** The recordings of task 11.2 (docs/CATALOG-TRIAL.md, "Version recordings"), asked as the app asks. */
const REC = (name: string) => recordedSearch(`versions_${name}.json`, 20);
const SEARCHES: Record<string, CatalogCard[]> = {
  "1990 topps 414 thomas": REC("1990_topps_414_thomas"),
  "1990 topps frank thomas": REC("1990_topps_frank_thomas"),
  "1989 fleer 616 ripken": REC("1989_fleer_616_ripken"),
  "1989 fleer bill ripken": REC("1989_fleer_bill_ripken"),
  "1987 fleer 604 bonds": REC("1987_fleer_604_bonds"),
  "1991 topps 333 jones": REC("1991_topps_333_jones"),
  "1992 topps 1 ryan": REC("1992_topps_1_ryan"),
  "1994 upper deck 24 rodriguez": REC("1994_upper_deck_24_rodriguez"),
  "1989 score 257 sanders": REC("1989_score_257_sanders"),
  "1986 fleer 57 jordan": REC("1986_fleer_57_jordan"),
};

const T0 = new Date("2026-11-16T10:00:00Z");
function vitem(over: Partial<VersionItem>): VersionItem {
  return {
    kind: "card", sport: "baseball", year: null, brand: null, setName: null, cardNumber: null, player: null, team: null,
    variation: null, fieldSources: null, firstSuggestion: null, ...over,
  };
}
const thomas = vitem({ year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas" });
const jones = vitem({ year: 1991, brand: "Topps", cardNumber: "333", player: "Chipper Jones" });
const names = (o: { name: string }[]) => o.map((x) => x.name);

describe("buildVersionOptions on the recordings", () => {
  it("base and Tiffany become two options with links; the known list joins Tiffany as a second line", () => {
    const o = buildVersionOptions(thomas, SEARCHES["1990 topps 414 thomas"]);
    expect(names(o)).toEqual([BASE_NAME, "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(o[0].evidence).toEqual([{ from: "catalog", text: "From MyCardfolio: 1990 Topps #414 Frank Thomas", url: expect.stringContaining("551111") }]);
    expect(o[0].card?.sourceId).toBe("551111");
    expect(o[1].card?.sourceId).toBe("551963");
    expect(o[1].evidence.map((e) => e.from)).toEqual(["catalog", "known_list"]);
    expect(o[1].evidence[0]).toMatchObject({ text: "From MyCardfolio: 1990 Topps #414 Frank Thomas (Tiffany)", url: expect.stringMatching(/^https:\/\/mycardfolio\.com\/.*551963$/) });
    expect(o[1].knownId).toBe("topps-tiffany");
    expect(o[2]).toMatchObject({ card: null, knownId: "opc", evidence: [{ from: "known_list" }] });
  });

  it("listings never become options", () => {
    const o = buildVersionOptions(vitem({ sport: "basketball", year: 1986, brand: "Fleer", cardNumber: "57", player: "Michael Jordan" }), SEARCHES["1986 fleer 57 jordan"]);
    expect(names(o)).toEqual([BASE_NAME, ANOTHER_NAME, NOT_SURE_NAME]);
    expect(o.every((x) => x.card === null && x.evidence.length === 0)).toBe(true);
    // In a mixed answer the eBay rows are left out too: only clean ids carry a card.
    const r = buildVersionOptions(vitem({ year: 1989, brand: "Fleer", cardNumber: "616", player: "Bill Ripken" }), SEARCHES["1989 fleer 616 ripken"]);
    expect(names(r)).toEqual([BASE_NAME, "Glossy", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(r.flatMap((x) => x.evidence).every((e) => !/ebay|ing_/.test(e.url ?? ""))).toBe(true);
  });

  it("another player with the same number, another year or another number is left out", () => {
    const tiffany = SEARCHES["1990 topps 414 thomas"].find((c) => c.sourceId === "551963")!;
    const others: CatalogCard[] = [
      { ...tiffany, sourceId: "900001", player: "Ken Griffey Jr.", variation: "Gold" },
      { ...tiffany, sourceId: "900002", year: 1991, variation: "Desert Shield" },
      { ...tiffany, sourceId: "900003", cardNumber: "415", variation: "Glossy" },
      { ...tiffany, sourceId: "900004", player: "Frank Thomasson", variation: "Silver" },
    ];
    const o = buildVersionOptions(thomas, [...SEARCHES["1990 topps 414 thomas"], ...others]);
    expect(names(o)).toEqual([BASE_NAME, "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
  });

  it("the same version from the catalog and the known list is one option with two lines", () => {
    const o = buildVersionOptions(jones, SEARCHES["1991 topps 333 jones"]);
    expect(names(o)).toEqual([BASE_NAME, "Desert Shield", "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
    for (const n of ["Desert Shield", "Tiffany"]) {
      const opt = o.find((x) => x.name === n)!;
      expect(opt.evidence.map((e) => e.from), n).toEqual(["catalog", "known_list"]);
      expect(opt.card, n).not.toBeNull();
    }
    const ryan = buildVersionOptions(vitem({ year: 1992, brand: "Topps", cardNumber: "1", player: "Nolan Ryan" }), SEARCHES["1992 topps 1 ryan"]);
    expect(names(ryan)).toEqual([BASE_NAME, "Gold", "Gold Promo Sheet", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(ryan[1].evidence.map((e) => e.from)).toEqual(["catalog", "known_list"]);
    // Upper Deck writes the parallel into the set name.
    const arod = buildVersionOptions(vitem({ year: 1994, brand: "Upper Deck", cardNumber: "24", player: "Alex Rodriguez" }), SEARCHES["1994 upper deck 24 rodriguez"]);
    expect(names(arod)).toEqual([BASE_NAME, "Electric Diamond", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(arod[1].evidence.map((e) => e.from)).toEqual(["catalog", "known_list"]);
    expect(arod[1].card?.sourceId).toBe("2799918");
  });

  it("a read word moves its option to second place and chooses nothing", () => {
    const read = { ...jones, firstSuggestion: buildFirstSuggestion({ variation: "TIFFANY" }, { confidence: 0.5, reader: "free", at: T0 }) };
    const o = buildVersionOptions(read, SEARCHES["1991 topps 333 jones"]);
    expect(names(o)).toEqual([BASE_NAME, "Tiffany", "Desert Shield", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(o[1].evidence[0]).toEqual({ from: "reading", text: "The reader read the word TIFFANY on the card", url: null });
    // A read variation field of the item counts too; an owner's one does not.
    const field = { ...jones, variation: "Topps Desert Shield", fieldSources: JSON.stringify({ variation: "reading" }) };
    expect(names(buildVersionOptions(field, SEARCHES["1991 topps 333 jones"])).slice(0, 2)).toEqual([BASE_NAME, "Desert Shield"]);
    const owners = { ...jones, variation: "Tiffany", fieldSources: JSON.stringify({ variation: "owner" }) };
    expect(buildVersionOptions(owners, SEARCHES["1991 topps 333 jones"]).some((x) => x.evidence.some((e) => e.from === "reading"))).toBe(false);
    // A read word that fits no option adds none.
    const gold = { ...thomas, firstSuggestion: buildFirstSuggestion({ variation: "GOLD" }, { confidence: 0.5, reader: "free", at: T0 }) };
    expect(names(buildVersionOptions(gold, SEARCHES["1990 topps 414 thomas"]))).toEqual([BASE_NAME, "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
  });

  it("gives at most 12 options, the fixed three always there", () => {
    const tiffany = SEARCHES["1990 topps 414 thomas"].find((c) => c.sourceId === "551963")!;
    const many = Array.from({ length: 20 }, (_, i) => ({ ...tiffany, sourceId: String(800000 + i), variation: `Foil ${i}` }));
    const o = buildVersionOptions(thomas, many);
    expect(o).toHaveLength(MAX_VERSION_OPTIONS);
    expect(o[0].kind).toBe("base");
    expect(o.slice(-2).map((x) => x.kind)).toEqual(["another", "not_sure"]);
  });

  it("with no catalog answer the known list and the fixed three still show", () => {
    expect(names(buildVersionOptions(jones, []))).toEqual([BASE_NAME, "Tiffany", "Desert Shield", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
    expect(names(buildVersionOptions(vitem({}), []))).toEqual([BASE_NAME, ANOTHER_NAME, NOT_SURE_NAME]);
  });

  it("finds more than one version of the same card in stored candidates", () => {
    const rows = SEARCHES["1990 topps 414 thomas"].map(slimCandidate);
    expect(hasSeveralVersions(rows)).toBe(true);
    expect(hasSeveralVersions(rows.filter((c) => c.sourceId !== "551963"))).toBe(false);
    expect(hasSeveralVersions(SEARCHES["1986 fleer 57 jordan"].map(slimCandidate))).toBe(false);
  });

  it("searches year brand number surname, and the full name only without a number", () => {
    expect(versionSearches(vitem({ year: 1990, brand: "Topps", cardNumber: "336", player: "Ken Griffey Jr." }))).toEqual(["1990 Topps 336 Griffey"]);
    expect(versionSearches({ ...thomas, cardNumber: null })).toEqual(["1990 Topps Thomas", "1990 Topps Frank Thomas"]);
    expect(versionSearches({ ...thomas, brand: null })).toEqual([]);
    expect(versionSearches({ ...thomas, player: null })).toEqual([]);
  });
});

// ---------- with the database ----------

let db: Db;
let clock: Date;
const now = () => clock;
const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;
const insert = (over: Partial<NewItem>) =>
  db.insert(items).values({ kind: "card", title: "x", status: "confirmed", ...over }).returning({ id: items.id }).get().id;
const thomasRow: Partial<NewItem> = {
  sport: "baseball", year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas",
  fieldSources: JSON.stringify({ sport: "reading", year: "reading", brand: "reading", cardNumber: "reading", player: "reading" }),
};
/** Every column the owner could see change on a card. */
function cardFields(row: Item) {
  const out: Record<string, unknown> = { isParallel: row.isParallel, catalogCardId: row.catalogCardId, title: row.title, isRookie: row.isRookie, rookieState: row.rookieState, firstSuggestion: row.firstSuggestion, estValueCents: row.estValueCents, manualValueCents: row.manualValueCents, status: row.status };
  for (const f of CATALOG_FIELDS) out[f] = row[f];
  return out;
}

beforeEach(() => {
  db = createDb(":memory:");
  clock = T0;
  resetShowVersionsLimitForTests();
});
afterEach(() => resetShowVersionsLimitForTests());

describe("loadVersionOptions", () => {
  it("stores the list, spends one search in the now line, and changes no field", async () => {
    const id = insert(thomasRow);
    const before = cardFields(get(id));
    const cat = new FakeCatalog({ searches: SEARCHES });
    const r = await loadVersionOptions(id, { db, catalog: cat, now });
    expect(r.ok).toBe(true);
    expect(cat.calls).toEqual(["search:1990 Topps 414 Thomas"]);
    expect(cat.lines).toEqual(["now"]);
    const row = get(id);
    expect(cardFields(row)).toEqual(before);
    expect(row.versionState).toBeNull();
    expect(row.versionSource).toBeNull();
    const stored = parseVersions(row.versionOptions, clock)!;
    expect(stored).toMatchObject({ at: T0.getTime(), catalog: "ok" });
    expect(names(stored.options)).toEqual([BASE_NAME, "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
  });

  it("asks twice, at most, only when the item has no number", async () => {
    const id = insert({ ...thomasRow, cardNumber: null });
    const cat = new FakeCatalog({ searches: SEARCHES });
    const r = await loadVersionOptions(id, { db, catalog: cat, now });
    expect(cat.calls).toEqual(["search:1990 Topps Thomas", "search:1990 Topps Frank Thomas"]);
    expect(r.ok && names(r.versions.options)).toEqual([BASE_NAME, "Tiffany", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
  });

  it("catalog off still gives the known list and the fixed three, and says so", async () => {
    const id = insert({ ...thomasRow, year: 1991, cardNumber: "333", player: "Chipper Jones" });
    for (const fail of ["off", "paused", "busy"] as const) {
      resetShowVersionsLimitForTests();
      const cat = new FakeCatalog({ fail });
      const r = await loadVersionOptions(id, { db, catalog: cat, now });
      expect(r.ok && r.versions.catalog).toBe(fail);
      expect(r.ok && names(r.versions.options)).toEqual([BASE_NAME, "Tiffany", "Desert Shield", "O-Pee-Chee", ANOTHER_NAME, NOT_SURE_NAME]);
      expect(cat.calls).toHaveLength(1);
    }
    resetShowVersionsLimitForTests();
    const broken = await loadVersionOptions(id, { db, catalog: new FakeCatalog({ throws: true }), now });
    expect(broken.ok && broken.versions.catalog).toBe("failed");
  });

  it("makes no call without year, brand and player", async () => {
    const id = insert({ sport: "baseball", year: 1990, cardNumber: "414", player: "Frank Thomas" });
    const cat = new FakeCatalog({ searches: SEARCHES });
    const r = await loadVersionOptions(id, { db, catalog: cat, now });
    expect(cat.calls).toEqual([]);
    expect(r.ok && r.versions.catalog).toBe("not_asked");
  });

  it("once per 10 seconds per item", async () => {
    const id = insert(thomasRow);
    const other = insert(thomasRow);
    const cat = new FakeCatalog({ searches: SEARCHES });
    expect((await loadVersionOptions(id, { db, catalog: cat, now })).ok).toBe(true);
    clock = new Date(T0.getTime() + SHOW_EVERY_MS - 1);
    expect(await loadVersionOptions(id, { db, catalog: cat, now })).toEqual({ ok: false, error: SHOW_WAIT });
    expect((await loadVersionOptions(other, { db, catalog: cat, now })).ok).toBe(true);
    clock = new Date(T0.getTime() + SHOW_EVERY_MS);
    expect((await loadVersionOptions(id, { db, catalog: cat, now })).ok).toBe(true);
    expect(cat.calls).toHaveLength(3);
  });

  it("a stored list older than 30 days is not used", () => {
    const raw = JSON.stringify({ v: 1, at: T0.getTime(), catalog: "ok", options: [{ kind: "base", name: BASE_NAME, evidence: [], card: null, knownId: null }] });
    expect(parseVersions(raw, T0)).not.toBeNull();
    expect(parseVersions(raw, new Date(T0.getTime() + 31 * 24 * 3600 * 1000))).toBeNull();
    expect(parseVersions("{bad", T0)).toBeNull();
  });
});

describe("chooseVersion", () => {
  async function shown(id: number) {
    const r = await loadVersionOptions(id, { db, catalog: new FakeCatalog({ searches: SEARCHES }), now });
    if (!r.ok) throw new Error(r.error);
    return r.versions;
  }
  const at = (v: { options: { name: string }[] }, name: string) => v.options.findIndex((o) => o.name === name);

  it("a catalog version: variation marked owner, parallel, linked, confirmed, list cleared, first suggestion untouched", async () => {
    const first = buildFirstSuggestion({ year: 1990, brand: "Topps", cardNumber: "414", player: "Frank Thomas" }, { confidence: 0.5, reader: "free", at: T0 });
    const id = insert({ ...thomasRow, firstSuggestion: first, estValueCents: 500 });
    const v = await shown(id);
    const r = chooseVersion(id, { position: at(v, "Tiffany"), listAt: v.at }, db, T0);
    expect(r).toEqual({ ok: true, state: "confirmed", source: "catalog", differences: [] });
    const row = get(id);
    expect(row).toMatchObject({ variation: "Tiffany", isParallel: true, versionState: "confirmed", versionSource: "catalog", versionOptions: null, firstSuggestion: first, estValueCents: 500 });
    expect(JSON.parse(row.fieldSources!).variation).toBe("owner");
    const card = db.select().from(catalogCards).where(eq(catalogCards.id, row.catalogCardId!)).get()!;
    expect(card.variation).toBe("Tiffany");
    expect(row.title).toBe("1990 Topps #414 Frank Thomas (Tiffany)");
  });

  it("an owner field survives a version link; a differing read field is listed, not changed", async () => {
    const id = insert({ ...thomasRow, player: "F. Thomas", team: "White Sox", brand: "TOPPS",
      fieldSources: JSON.stringify({ sport: "reading", year: "reading", brand: "reading", cardNumber: "reading", player: "owner", team: "owner" }) });
    const v = await shown(id);
    const r = chooseVersion(id, { position: at(v, "Tiffany"), listAt: v.at }, db, T0);
    expect(r.ok).toBe(true);
    const row = get(id);
    expect(row).toMatchObject({ player: "F. Thomas", team: "White Sox", brand: "TOPPS", variation: "Tiffany" });
    expect(JSON.parse(row.fieldSources!)).toMatchObject({ player: "owner", team: "owner", variation: "owner" });
  });

  it("an item linked to the base card gets the chosen card instead", async () => {
    const id = insert(thomasRow);
    const base = SEARCHES["1990 topps 414 thomas"].find((c) => c.sourceId === "551111")!;
    const saved = saveCatalogCardIn(db, base, T0);
    if (!saved.ok) throw new Error("not saved");
    expect(linkCatalogCard(id, saved.catalogCardId, db).ok).toBe(true);
    const v = await shown(id);
    expect(chooseVersion(id, { position: at(v, "Tiffany"), listAt: v.at }, db, T0).ok).toBe(true);
    const row = get(id);
    expect(row.catalogCardId).not.toBe(saved.catalogCardId);
    expect(db.select().from(catalogCards).where(eq(catalogCards.id, row.catalogCardId!)).get()!.variation).toBe("Tiffany");
    expect(db.select().from(catalogCards).all()).toHaveLength(2);
  });

  it("base: variation emptied, not a parallel, mark removed, the catalog's base card linked", async () => {
    const id = insert({ ...thomasRow, variation: "Tiffany", isParallel: true, fieldSources: JSON.stringify({ ...JSON.parse(thomasRow.fieldSources!), variation: "reading" }) });
    const v = await shown(id);
    expect(chooseVersion(id, { position: 0, listAt: v.at }, db, T0)).toMatchObject({ ok: true, state: "confirmed", source: "owner" });
    const row = get(id);
    expect(row).toMatchObject({ variation: null, isParallel: false, versionState: "confirmed", versionSource: "owner" });
    expect(db.select().from(catalogCards).where(eq(catalogCards.id, row.catalogCardId!)).get()).toMatchObject({ variation: null, year: 1990 });
    expect(JSON.parse(row.fieldSources!).variation).toBeUndefined();
    expect(row.title).toBe("1990 Topps #414 Frank Thomas");
  });

  it("base on an item linked to Tiffany unlinks it and links the base card; no base card in the list: it only unlinks", async () => {
    const id = insert(thomasRow);
    let v = await shown(id);
    expect(chooseVersion(id, { position: at(v, "Tiffany"), listAt: v.at }, db, T0).ok).toBe(true);
    const tiffanyId = get(id).catalogCardId;
    expect(tiffanyId).not.toBeNull();
    clock = new Date(T0.getTime() + SHOW_EVERY_MS);
    v = await shown(id);
    expect(chooseVersion(id, { position: 0, listAt: v.at }, db, clock).ok).toBe(true);
    const row = get(id);
    expect(row.catalogCardId).not.toBe(tiffanyId);
    expect(db.select().from(catalogCards).where(eq(catalogCards.id, row.catalogCardId!)).get()!.variation).toBeNull();
    expect(row).toMatchObject({ variation: null, isParallel: false, versionState: "confirmed" });
    // A list without a base card: the link to Tiffany just goes.
    const id2 = insert(thomasRow);
    const v2 = await shown(id2);
    expect(chooseVersion(id2, { position: at(v2, "Tiffany"), listAt: v2.at }, db, T0).ok).toBe(true);
    const stored = parseVersions(JSON.stringify({ v: 1, at: T0.getTime(), catalog: "ok", options: v2.options.map((o) => (o.kind === "base" ? { ...o, card: null } : o)) }), T0)!;
    db.update(items).set({ versionOptions: JSON.stringify({ v: 1, at: stored.at, catalog: "ok", options: stored.options }) }).where(eq(items.id, id2)).run();
    expect(chooseVersion(id2, { position: 0, listAt: stored.at }, db, T0).ok).toBe(true);
    expect(get(id2)).toMatchObject({ catalogCardId: null, variation: null, versionState: "confirmed" });
  });

  it("a known list version on an item linked to the base card unlinks it", async () => {
    const id = insert(thomasRow);
    const base = SEARCHES["1990 topps 414 thomas"].find((c) => c.sourceId === "551111")!;
    const saved = saveCatalogCardIn(db, base, T0);
    if (!saved.ok) throw new Error("not saved");
    expect(linkCatalogCard(id, saved.catalogCardId, db).ok).toBe(true);
    const v = await shown(id);
    expect(chooseVersion(id, { position: at(v, "O-Pee-Chee"), listAt: v.at }, db, T0).ok).toBe(true);
    expect(get(id)).toMatchObject({ catalogCardId: null, variation: "O-Pee-Chee", versionSource: "known_list" });
  });

  it("Show versions: 6 per minute for all items together, counted in the activity log", async () => {
    const cat = new FakeCatalog({ searches: SEARCHES });
    const ids = Array.from({ length: 7 }, () => insert(thomasRow));
    for (const id of ids.slice(0, 6)) expect((await loadVersionOptions(id, { db, catalog: cat, now })).ok).toBe(true);
    expect(await loadVersionOptions(ids[6], { db, catalog: cat, now })).toEqual({ ok: false, error: SHOW_BUSY });
    expect(get(ids[6]).versionOptions).toBeNull();
    clock = new Date(T0.getTime() + 61_000);
    expect((await loadVersionOptions(ids[6], { db, catalog: cat, now })).ok).toBe(true);
  });

  it("a known list version links nothing; another version takes the typed name", async () => {
    const id = insert(thomasRow);
    let v = await shown(id);
    expect(chooseVersion(id, { position: at(v, "O-Pee-Chee"), listAt: v.at }, db, T0)).toMatchObject({ ok: true, source: "known_list" });
    expect(get(id)).toMatchObject({ variation: "O-Pee-Chee", isParallel: true, catalogCardId: null, versionSource: "known_list" });
    clock = new Date(T0.getTime() + SHOW_EVERY_MS);
    v = await shown(id);
    const another = at(v, ANOTHER_NAME);
    expect(chooseVersion(id, { position: another, listAt: v.at, text: " x " }, db, clock).ok).toBe(false);
    expect(chooseVersion(id, { position: another, listAt: v.at, text: "  Blue   foil  " }, db, clock)).toMatchObject({ ok: true, source: "owner" });
    expect(get(id)).toMatchObject({ variation: "Blue foil", isParallel: true, versionSource: "owner" });
  });

  it("not sure changes no field", async () => {
    const id = insert({ ...thomasRow, variation: "Gold", isParallel: true, estValueCents: 900, manualValueCents: 1200 });
    const before = cardFields(get(id));
    const v = await shown(id);
    expect(chooseVersion(id, { position: at(v, NOT_SURE_NAME), listAt: v.at }, db, T0)).toEqual({ ok: true, state: "not_sure", source: null, differences: [] });
    const row = get(id);
    expect(cardFields(row)).toEqual(before);
    expect(row).toMatchObject({ versionState: "not_sure", versionSource: null, versionOptions: null });
  });

  it("refuses a place that is not on the stored list, an old list, and a second use of the same list", async () => {
    const id = insert(thomasRow);
    const v = await shown(id);
    expect(v.options).toHaveLength(5);
    const before = get(id);
    expect(chooseVersion(id, { position: 9, listAt: v.at }, db, T0)).toEqual({ ok: false, error: LIST_CHANGED });
    expect(chooseVersion(id, { position: -1, listAt: v.at }, db, T0)).toEqual({ ok: false, error: LIST_CHANGED });
    expect(chooseVersion(id, { position: 1, listAt: v.at - 1 }, db, T0)).toEqual({ ok: false, error: LIST_CHANGED });
    expect(get(id)).toEqual(before);
    expect(chooseVersion(id, { position: 1, listAt: v.at }, db, T0).ok).toBe(true);
    expect(chooseVersion(id, { position: 0, listAt: v.at }, db, T0)).toEqual({ ok: false, error: LIST_CHANGED });
    expect(get(id).variation).toBe("Tiffany");
  });

  it("refuses an item never shown a list, a deleted item, and a sealed item", async () => {
    const id = insert(thomasRow);
    expect(chooseVersion(id, { position: 0, listAt: T0.getTime() }, db, T0)).toEqual({ ok: false, error: LIST_CHANGED });
    const sealed = insert({ kind: "sealed" });
    expect((await loadVersionOptions(sealed, { db, catalog: new FakeCatalog(), now })).ok).toBe(false);
    const v = await shown(id);
    db.update(items).set({ deletedAt: T0 }).where(eq(items.id, id)).run();
    expect(chooseVersion(id, { position: 0, listAt: v.at }, db, T0).ok).toBe(false);
  });
});
