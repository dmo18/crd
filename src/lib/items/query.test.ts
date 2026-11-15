import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, locations, type NewItem } from "@/db/schema";
import { PAGE_SIZE, inventoryFilterSchema, listItems } from "./query";

let db: Db;
let box: number;
beforeEach(() => {
  db = createDb(":memory:");
  box = db.insert(locations).values({ name: "Box 1" }).returning({ id: locations.id }).get().id;
});

function add(over: Partial<NewItem> & { title: string }): number {
  return db.insert(items).values({ kind: "card", ...over }).returning({ id: items.id }).get().id;
}
const parse = (p: Record<string, string | string[] | undefined>) => inventoryFilterSchema.parse(p);
const titles = (p: Record<string, string>) => listItems(parse(p), db).rows.map((r) => r.title);

function seed() {
  add({ title: "Griffey Rookie", player: "Ken Griffey Jr.", team: "Mariners", brand: "Upper Deck", setName: "Base", cardNumber: "1", year: 1989, sport: "baseball", isRookie: true, rarityTier: "key", estValueCents: 10000, locationId: box, status: "confirmed" });
  add({ title: "Jordan Fleer", player: "Michael Jordan", team: "Bulls", brand: "Fleer", year: 1986, sport: "basketball", rarityTier: "grail", estValueCents: 50000, manualValueCents: 20000, quantity: 2, locationId: box });
  add({ title: "Brady Topps", player: "Tom Brady", team: "Patriots", year: 2000, sport: "football", rarityTier: "star" });
  add({ title: "Sealed Box", kind: "sealed", year: 1990, sport: "baseball", estValueCents: 3000 });
  add({ title: "bulk lot", kind: "bulk", description: "mixed commons", notes: "100% junk_wax", quantity: 3, estValueCents: 100 });
  add({ title: "Zed", player: "alpha one" });
  add({ title: "Alpha", player: "Beta Two", year: 1995 });
}

describe("inventoryFilterSchema", () => {
  it("falls back for invalid values", () => {
    const f = parse({ kind: "nope", sport: "x", status: "x", tier: "x", rookie: "yes", yearFrom: "1500", yearTo: "abc", location: "-3", sort: "weird", page: "0", q: "x".repeat(101) });
    expect(f).toEqual({ sort: "newest", page: 1 });
  });
  it("accepts valid values and the first of repeats", () => {
    const f = parse({ q: "  griffey ", kind: ["card", "bulk"], rookie: "1", yearFrom: "1980", yearTo: "2000", location: "none", sort: "player", page: "3", tier: "key" });
    expect(f).toMatchObject({ q: "griffey", kind: "card", rookie: true, yearFrom: 1980, yearTo: 2000, location: "none", sort: "player", page: 3, tier: "key" });
    expect(parse({ location: "7" }).location).toBe(7);
  });
});

describe("filters", () => {
  beforeEach(seed);
  it("kind", () => expect(titles({ kind: "sealed" })).toEqual(["Sealed Box"]));
  it("sport", () => expect(titles({ sport: "basketball" })).toEqual(["Jordan Fleer"]));
  it("status", () => expect(titles({ status: "confirmed" })).toEqual(["Griffey Rookie"]));
  it("tier", () => expect(titles({ tier: "grail" })).toEqual(["Jordan Fleer"]));
  it("rookie", () => expect(titles({ rookie: "1" })).toEqual(["Griffey Rookie"]));
  it("year range", () => {
    expect(titles({ yearFrom: "1989", yearTo: "1990", sort: "year_asc" })).toEqual(["Griffey Rookie", "Sealed Box"]);
  });
  it("location and no location", () => {
    expect(titles({ location: String(box), sort: "oldest" })).toEqual(["Griffey Rookie", "Jordan Fleer"]);
    expect(listItems(parse({ location: "none" }), db).total).toBe(5);
  });
});

describe("search", () => {
  beforeEach(seed);
  it("matches case-insensitively across columns", () => {
    expect(titles({ q: "MARINERS" })).toEqual(["Griffey Rookie"]);
    expect(titles({ q: "commons" })).toEqual(["bulk lot"]);
  });
  it("requires every word", () => {
    expect(titles({ q: "griffey upper" })).toEqual(["Griffey Rookie"]);
    expect(titles({ q: "griffey fleer" })).toEqual([]);
  });
  it("treats % and _ literally", () => {
    expect(titles({ q: "100%" })).toEqual(["bulk lot"]);
    expect(titles({ q: "junk_wax" })).toEqual(["bulk lot"]);
    expect(titles({ q: "junk_wax" }).length).toBe(1);
    expect(titles({ q: "%" })).toEqual(["bulk lot"]);
    expect(titles({ q: "junk?wax" })).toEqual([]);
    expect(titles({ q: "\\" })).toEqual([]);
  });
});

describe("sorting", () => {
  beforeEach(seed);
  it("newest and oldest tie-break by id", () => {
    const all = titles({});
    expect(all[0]).toBe("Alpha");
    expect(titles({ sort: "oldest" })[0]).toBe("Griffey Rookie");
  });
  it("value puts no value last both ways", () => {
    expect(titles({ sort: "value_desc" }).slice(0, 4)).toEqual(["Jordan Fleer", "Griffey Rookie", "Sealed Box", "bulk lot"]);
    expect(titles({ sort: "value_asc" }).slice(0, 4)).toEqual(["bulk lot", "Sealed Box", "Griffey Rookie", "Jordan Fleer"]);
    expect(titles({ sort: "value_asc" }).slice(-3)).toEqual(["Alpha", "Zed", "Brady Topps"]);
    expect(titles({ sort: "value_desc" }).slice(-3)).toEqual(["Alpha", "Zed", "Brady Topps"]);
  });
  it("year puts no year last both ways", () => {
    expect(titles({ sort: "year_asc" }).slice(0, 3)).toEqual(["Jordan Fleer", "Griffey Rookie", "Sealed Box"]);
    expect(titles({ sort: "year_desc" }).slice(0, 2)).toEqual(["Brady Topps", "Alpha"]);
    expect(titles({ sort: "year_desc" }).slice(-2).every((t) => ["Zed", "bulk lot"].includes(t))).toBe(true);
  });
  it("player is case-insensitive with empty last", () => {
    const t = titles({ sort: "player" });
    expect(t.slice(0, 4)).toEqual(["Zed", "Alpha", "Griffey Rookie", "Jordan Fleer"]);
    expect(t[4]).toBe("Brady Topps");
    expect(t.slice(5).sort()).toEqual(["Sealed Box", "bulk lot"]);
  });
  it("title is case-insensitive", () => {
    expect(titles({ sort: "title" })).toEqual(["Alpha", "Brady Topps", "bulk lot", "Griffey Rookie", "Jordan Fleer", "Sealed Box", "Zed"]);
  });
});

describe("totals and paging", () => {
  it("multiplies by quantity and lets the manual value win", () => {
    seed();
    const r = listItems(parse({}), db);
    expect(r.total).toBe(7);
    expect(r.totalUnits).toBe(1 + 2 + 1 + 1 + 3 + 1 + 1);
    expect(r.totalValueCents).toBe(10000 + 2 * 20000 + 3000 + 3 * 100);
  });
  it("totals cover the whole filtered set, not the page", () => {
    for (let i = 0; i < 85; i++) add({ title: `Card ${i}`, estValueCents: 100 });
    const p1 = listItems(parse({}), db);
    expect(p1.rows).toHaveLength(PAGE_SIZE);
    expect(p1.pageCount).toBe(3);
    expect(p1.totalValueCents).toBe(8500);
    const p3 = listItems(parse({ page: "3" }), db);
    expect(p3.rows).toHaveLength(5);
    expect(listItems(parse({ page: "99" }), db).page).toBe(3);
    const ids = new Set([...p1.rows, ...listItems(parse({ page: "2" }), db).rows, ...p3.rows].map((r) => r.id));
    expect(ids.size).toBe(85);
  });
  it("empty set has one page", () => {
    expect(listItems(parse({}), db)).toMatchObject({ rows: [], total: 0, totalUnits: 0, totalValueCents: 0, page: 1, pageCount: 1 });
  });
});
