import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, setDbForTests, type Db } from "@/db";
import { items, type NewItem } from "@/db/schema";
import { exportPick, MAX_EXPORT_IDS } from "./select";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
  setDbForTests(db);
});
afterEach(() => setDbForTests(undefined));

const add = (over: Partial<NewItem> = {}) => db.insert(items).values({ kind: "card", title: "T", ...over }).returning({ id: items.id }).get().id;
const ids = (q: string) => {
  const r = exportPick(new URLSearchParams(q), db);
  if ("error" in r) throw new Error(r.error);
  return { ids: r.rows.map((x) => x.id), what: r.what };
};

describe("exportPick", () => {
  it("exports the whole collection, the filtered items on every page, or exactly the ticked ones, never deleted ones", () => {
    const a = add({ sport: "baseball" });
    const b = add({ sport: "hockey" });
    const c = add({ sport: "baseball" });
    add({ sport: "baseball", deletedAt: new Date() });
    expect(ids("")).toEqual({ ids: [a, b, c], what: "all" });
    expect(ids("sort=player&page=2")).toEqual({ ids: [a, b, c], what: "all" });
    expect(ids("sport=baseball&page=3")).toEqual({ ids: [a, c], what: "filtered" });
    expect(ids(`ids=${c},${a},${a}`)).toEqual({ ids: [a, c], what: "selected" });
    expect(ids(`ids=${b},999`)).toEqual({ ids: [b], what: "selected" });
  });

  it("refuses bad or too many ids", () => {
    expect(exportPick(new URLSearchParams("ids=1,x"), db)).toHaveProperty("error");
    expect(exportPick(new URLSearchParams("ids="), db)).toHaveProperty("error");
    const many = Array.from({ length: MAX_EXPORT_IDS + 1 }, (_, i) => i + 1).join(",");
    expect(exportPick(new URLSearchParams(`ids=${many}`), db)).toHaveProperty("error");
  });
});
