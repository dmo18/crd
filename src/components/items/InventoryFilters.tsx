import { Button, Field, INPUT_CLASS, LinkButton } from "@/components/ui";
import { ITEM_KINDS, ITEM_STATUSES, RARITY_TIERS, SPORTS, type Location } from "@/db/schema";
import { KIND_LABELS, RARITY_LABELS, SPORT_LABELS } from "@/lib/items/labels";
import type { InventoryFilters as Filters } from "@/lib/items/query";

const STATUS_LABELS = { needs_review: "Needs review", confirmed: "Confirmed" } as const;
const SORT_OPTIONS = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["value_desc", "Highest value"],
  ["value_asc", "Lowest value"],
  ["year_asc", "Year, oldest first"],
  ["year_desc", "Year, newest first"],
  ["player", "Player A to Z"],
  ["title", "Title A to Z"],
] as const;

/** Short phrases for the "Filters on" line, e.g. "Kind Card". */
export function activeFilterLabels(f: Filters, locations: Pick<Location, "id" | "name">[]): string[] {
  const out: string[] = [];
  if (f.kind) out.push(`Kind ${KIND_LABELS[f.kind]}`);
  if (f.sport) out.push(`Sport ${SPORT_LABELS[f.sport]}`);
  if (f.tier) out.push(`Rarity ${RARITY_LABELS[f.tier]}`);
  if (f.status) out.push(`Status ${STATUS_LABELS[f.status]}`);
  if (f.location === "none") out.push("No location");
  else if (f.location != null) out.push(`Location ${locations.find((l) => l.id === f.location)?.name ?? "Unknown"}`);
  if (f.rookie) out.push("Rookies only");
  if (f.yearFrom != null) out.push(`From ${f.yearFrom}`);
  if (f.yearTo != null) out.push(`To ${f.yearTo}`);
  return out;
}

export function InventoryFilters({ filters, locations }: { filters: Filters; locations: Pick<Location, "id" | "name">[] }) {
  const active = activeFilterLabels(filters, locations);
  return (
    <form method="get" action="/items" className="flex flex-col gap-3 pb-4">
      <Field label="Search" htmlFor="inv-q">
        <input id="inv-q" name="q" type="search" defaultValue={filters.q ?? ""} maxLength={100}
          placeholder="Player, set, team, number" className={INPUT_CLASS} />
      </Field>
      <Field label="Sort by" htmlFor="inv-sort">
        <select id="inv-sort" name="sort" defaultValue={filters.sort} className={INPUT_CLASS}>
          {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <details open={active.length > 0} className="rounded-2xl border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">Filters</summary>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <Field label="Kind" htmlFor="inv-kind">
            <select id="inv-kind" name="kind" defaultValue={filters.kind ?? ""} className={INPUT_CLASS}>
              <option value="">Any kind</option>
              {ITEM_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </Field>
          <Field label="Sport" htmlFor="inv-sport">
            <select id="inv-sport" name="sport" defaultValue={filters.sport ?? ""} className={INPUT_CLASS}>
              <option value="">Any sport</option>
              {SPORTS.map((s) => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
            </select>
          </Field>
          <Field label="Rarity" htmlFor="inv-tier">
            <select id="inv-tier" name="tier" defaultValue={filters.tier ?? ""} className={INPUT_CLASS}>
              <option value="">Any rarity</option>
              {RARITY_TIERS.map((t) => <option key={t} value={t}>{RARITY_LABELS[t]}</option>)}
            </select>
          </Field>
          <Field label="Status" htmlFor="inv-status">
            <select id="inv-status" name="status" defaultValue={filters.status ?? ""} className={INPUT_CLASS}>
              <option value="">Any status</option>
              {ITEM_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </Field>
          <Field label="Location" htmlFor="inv-location">
            <select id="inv-location" name="location" defaultValue={filters.location == null ? "" : String(filters.location)} className={INPUT_CLASS}>
              <option value="">Anywhere</option>
              <option value="none">No location</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <label htmlFor="inv-rookie" className="flex min-h-11 items-center gap-3 text-base font-semibold">
            <input id="inv-rookie" name="rookie" type="checkbox" value="1" defaultChecked={filters.rookie === true} className="size-6 accent-accent" />
            Rookies only
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Year from" htmlFor="inv-year-from">
              <input id="inv-year-from" name="yearFrom" type="number" inputMode="numeric" min={1860} max={2100}
                defaultValue={filters.yearFrom ?? ""} placeholder="1986" className={INPUT_CLASS} />
            </Field>
            <Field label="Year to" htmlFor="inv-year-to">
              <input id="inv-year-to" name="yearTo" type="number" inputMode="numeric" min={1860} max={2100}
                defaultValue={filters.yearTo ?? ""} placeholder="1994" className={INPUT_CLASS} />
            </Field>
          </div>
        </div>
      </details>
      {active.length > 0 ? <p className="text-sm text-muted">Filters on: {active.join(", ")}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        <Button type="submit">Apply</Button>
        <LinkButton href="/items" variant="secondary">Clear</LinkButton>
      </div>
    </form>
  );
}
