import Link from "next/link";
import { filterParams } from "@/components/manage/filter-url";
import type { InventoryFilters } from "@/lib/items/query";

type Chip = { label: string; key: "missing" | "flag" | "status"; value: string };
const CHIPS: Chip[] = [
  { label: "No player", key: "missing", value: "player" },
  { label: "No year", key: "missing", value: "year" },
  { label: "No value", key: "missing", value: "value" },
  { label: "No location", key: "missing", value: "location" },
  { label: "Possible duplicates", key: "flag", value: "duplicates" },
  { label: "Unsure reads", key: "flag", value: "lowConfidence" },
  { label: "Needs review", key: "status", value: "needs_review" },
  { label: "Sold and removed", key: "status", value: "gone" },
];

/** One row of quick filters. Tap one to turn it on, tap it again to turn it off. */
export function SmartChips({ filters, basePath }: { filters: InventoryFilters; basePath: string }) {
  return (
    <nav aria-label="Quick filters" className="-mx-4 pb-3">
      <ul className="flex gap-2 overflow-x-auto px-4 pb-1">
        {CHIPS.map((c) => {
          const on = filters[c.key] === c.value;
          const qs = filterParams(filters, { [c.key]: on ? null : c.value }).toString();
          return (
            <li key={c.label} className="shrink-0">
              <Link
                href={qs ? `${basePath}?${qs}` : basePath}
                aria-current={on ? "true" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold whitespace-nowrap ${on ? "border-accent bg-accent text-accent-text" : "border-border bg-surface-2 text-text"}`}
              >
                {c.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
