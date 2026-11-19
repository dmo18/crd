import { describe, expect, it } from "vitest";
import { inventoryFilterSchema } from "@/lib/items/query";
import { selectionFiltersSchema } from "@/lib/items/bulk";
import { filterKey, filterParams, selectionFilters } from "./filter-url";

describe("manage filter helpers", () => {
  const f = inventoryFilterSchema.parse({ q: "griffey", missing: "year", sort: "player", page: "3" });
  it("builds chip links that keep the other settings and drop the page", () => {
    expect(filterParams(f).toString()).toBe("q=griffey&missing=year&sort=player");
    expect(filterParams(f, { missing: null }).toString()).toBe("q=griffey&sort=player");
    expect(filterParams(f, { flag: "duplicates" }).get("flag")).toBe("duplicates");
  });
  it("keeps the version filter in links and in the bulk selection", () => {
    const v = inventoryFilterSchema.parse({ version: "not_sure" });
    expect(filterParams(v).toString()).toBe("version=not_sure");
    expect(selectionFilters(v)).toEqual({ version: "not_sure" });
    expect(selectionFiltersSchema.safeParse(selectionFilters(v)).success).toBe(true);
  });
  it("sends the server only real filters, and the key ignores page and sort", () => {
    expect(selectionFilters(f)).toEqual({ q: "griffey", missing: "year" });
    const other = inventoryFilterSchema.parse({ q: "griffey", missing: "year", page: "1" });
    expect(filterKey(other)).toBe(filterKey(f));
  });
});
