import type { InventoryFilters } from "@/lib/items/query";

type Base = Omit<InventoryFilters, "page"> & { page?: number };

/** The filter settings as URL params (default sort and page left out). Used for chip links and paging. */
export function filterParams(f: Base, over: Partial<Record<"missing" | "flag" | "status", string | null>> = {}): URLSearchParams {
  const sp = new URLSearchParams();
  const put = (k: string, v: string | number | undefined | null) => { if (v !== undefined && v !== null && v !== "") sp.set(k, String(v)); };
  put("q", f.q);
  put("kind", f.kind);
  put("sport", f.sport);
  put("status", "status" in over ? over.status : f.status);
  put("tier", f.tier?.join(","));
  if (f.rookie) sp.set("rookie", "1");
  put("yearFrom", f.yearFrom);
  put("yearTo", f.yearTo);
  put("location", f.location);
  put("value", f.value);
  put("missing", "missing" in over ? over.missing : f.missing);
  put("flag", "flag" in over ? over.flag : f.flag);
  if (f.sort && f.sort !== "newest") sp.set("sort", f.sort);
  return sp;
}

/** The part of the filters a bulk change needs: no page, no sort, no empty values. */
export function selectionFilters(f: Base): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== "sort" && k !== "page" && v !== undefined));
}

/** A string that changes when the search or filters change (not when the page or sort does). */
export function filterKey(f: Base): string {
  return JSON.stringify(selectionFilters(f));
}
