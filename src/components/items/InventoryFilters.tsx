import { FilterSheet } from "@/components/items/FilterSheet";
import { SmartChips } from "@/components/items/SmartChips";
import { SubmitOnChange } from "@/components/items/SubmitOnChange";
import { Button, Field, INPUT_CLASS, LinkButton } from "@/components/ui";
import { ITEM_KINDS, ITEM_STATUSES, RARITY_TIERS, SPORTS, type Location } from "@/db/schema";
import { KIND_LABELS, RARITY_LABELS, SPORT_LABELS, STATUS_LABELS as ITEM_STATUS_LABELS } from "@/lib/items/labels";
import { countFilters, type InventoryFilters as Filters } from "@/lib/items/query";

const STATUS_LABELS = { ...ITEM_STATUS_LABELS, gone: "Sold and removed" } as const;
/** The yes or no marks, each its own box in the sheet. Same names as the link. */
const MARK_LABELS = {
  autograph: "Autograph", relic: "Relic or memorabilia", error: "Error card", parallel: "Parallel", insert: "Insert",
  serial: "Serial numbered", multi: "More than one copy",
} as const;
const GRADING_LABELS = { graded: "Graded", raw: "Raw (not graded)" } as const;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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

const MISSING_LABELS = {
  player: "No player", year: "No year", brand: "No brand", cardNumber: "No card number", team: "No team",
  location: "No location", value: "No value", photo: "No photo",
} as const;
const FLAG_LABELS = { duplicates: "Possible duplicates", lowConfidence: "Unsure reads" } as const;

/** The dashboard's "Key cards" tile counts both of these. */
const KEY_OR_GRAIL = "key,grail";

/** Short phrases for the "Filters on" line, e.g. "Kind Card". */
export function activeFilterLabels(f: Filters, locations: Pick<Location, "id" | "name">[]): string[] {
  const out: string[] = [];
  if (f.kind) out.push(`Kind ${KIND_LABELS[f.kind]}`);
  if (f.sport) out.push(`Sport ${SPORT_LABELS[f.sport]}`);
  if (f.tier?.length) out.push(`Rarity ${f.tier.map((t) => RARITY_LABELS[t]).join(" or ")}`);
  if (f.status) out.push(`Status ${STATUS_LABELS[f.status]}`);
  if (f.location === "none") out.push("No location");
  else if (f.location != null) out.push(`Location ${locations.find((l) => l.id === f.location)?.name ?? "Unknown"}`);
  if (f.value === "none") out.push("No price yet");
  if (f.missing) out.push(MISSING_LABELS[f.missing]);
  if (f.flag) out.push(FLAG_LABELS[f.flag]);
  if (f.version) out.push("Version not sure");
  if (f.rookie) out.push("Rookies only");
  for (const k of Object.keys(MARK_LABELS) as (keyof typeof MARK_LABELS)[]) if (f[k]) out.push(MARK_LABELS[k]);
  if (f.grading) out.push(GRADING_LABELS[f.grading]);
  if (f.grader) out.push(`Grader ${f.grader}`);
  if (f.grade) out.push(`Grade ${f.grade}`);
  if (f.variation) out.push(`Version or parallel ${f.variation}`);
  if (f.player) out.push(`Player ${f.player}`);
  if (f.team) out.push(`Team ${f.team}`);
  if (f.set) out.push(`Set ${f.set}`);
  if (f.minValue != null) out.push(`Value from ${usd(f.minValue)}`);
  if (f.maxValue != null) out.push(`Value up to ${usd(f.maxValue)}`);
  if (f.yearFrom != null) out.push(`From ${f.yearFrom}`);
  if (f.yearTo != null) out.push(`To ${f.yearTo}`);
  return out;
}

export function InventoryFilters({ filters, locations, action = "/items" }: {
  filters: Filters; locations: Pick<Location, "id" | "name">[]; action?: "/items" | "/manage";
}) {
  const active = activeFilterLabels(filters, locations);
  const count = countFilters(filters);
  return (
    <>
    <SmartChips filters={filters} basePath={action} />
    <form method="get" action={action} className="flex flex-col gap-3 pb-4">
      {filters.missing ? <input type="hidden" name="missing" value={filters.missing} /> : null}
      {filters.flag ? <input type="hidden" name="flag" value={filters.flag} /> : null}
      {filters.player ? <input type="hidden" name="player" value={filters.player} /> : null}
      {filters.team ? <input type="hidden" name="team" value={filters.team} /> : null}
      {filters.set ? <input type="hidden" name="set" value={filters.set} /> : null}
      <Field label="Search" htmlFor="inv-q">
        <input id="inv-q" name="q" type="search" defaultValue={filters.q ?? ""} maxLength={100}
          placeholder="Player, set, team, number" className={INPUT_CLASS} />
      </Field>
      <Field label="Sort by" htmlFor="inv-sort">
        <SubmitOnChange id="inv-sort" name="sort" defaultValue={filters.sort} className={INPUT_CLASS}>
          {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </SubmitOnChange>
      </Field>
      <FilterSheet count={count} clearHref={action}>
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
          <select id="inv-tier" name="tier" defaultValue={filters.tier?.join(",") ?? ""} className={INPUT_CLASS}>
            <option value="">Any rarity</option>
            <option value={KEY_OR_GRAIL}>Key card or grail</option>
            {RARITY_TIERS.map((t) => <option key={t} value={t}>{RARITY_LABELS[t]}</option>)}
            {filters.tier && filters.tier.length > 1 && filters.tier.join(",") !== KEY_OR_GRAIL ? (
              <option value={filters.tier.join(",")}>{filters.tier.map((t) => RARITY_LABELS[t]).join(" or ")}</option>
            ) : null}
          </select>
        </Field>
        <Field label="Status" htmlFor="inv-status" hint="Sold and removed items are kept out of every total and list until you ask for them here.">
          <select id="inv-status" name="status" defaultValue={filters.status ?? ""} className={INPUT_CLASS}>
            <option value="">In my collection</option>
            {ITEM_STATUSES.filter((s) => s === "needs_review" || s === "confirmed").map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            <option value="gone">{STATUS_LABELS.gone}</option>
            <option value="sold">{STATUS_LABELS.sold}</option>
            <option value="removed">{STATUS_LABELS.removed}</option>
          </select>
        </Field>
        <Field label="Location" htmlFor="inv-location">
          <select id="inv-location" name="location" defaultValue={filters.location == null ? "" : String(filters.location)} className={INPUT_CLASS}>
            <option value="">Anywhere</option>
            <option value="none">No location</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Price" htmlFor="inv-value">
          <select id="inv-value" name="value" defaultValue={filters.value ?? ""} className={INPUT_CLASS}>
            <option value="">Any</option>
            <option value="none">No price yet</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value from ($)" htmlFor="inv-min-value" hint="For one card or item.">
            <input id="inv-min-value" name="minValue" type="number" inputMode="decimal" min={0} step="0.01"
              defaultValue={filters.minValue ?? ""} placeholder="5" className={INPUT_CLASS} />
          </Field>
          <Field label="Value up to ($)" htmlFor="inv-max-value">
            <input id="inv-max-value" name="maxValue" type="number" inputMode="decimal" min={0} step="0.01"
              defaultValue={filters.maxValue ?? ""} placeholder="100" className={INPUT_CLASS} />
          </Field>
        </div>
        <Field label="Graded or raw" htmlFor="inv-grading">
          <select id="inv-grading" name="grading" defaultValue={filters.grading ?? ""} className={INPUT_CLASS}>
            <option value="">Any</option>
            <option value="graded">{GRADING_LABELS.graded}</option>
            <option value="raw">{GRADING_LABELS.raw}</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Grader" htmlFor="inv-grader">
            <input id="inv-grader" name="grader" defaultValue={filters.grader ?? ""} maxLength={20} placeholder="PSA" className={INPUT_CLASS} />
          </Field>
          <Field label="Grade" htmlFor="inv-grade">
            <input id="inv-grade" name="grade" defaultValue={filters.grade ?? ""} maxLength={20} placeholder="10" className={INPUT_CLASS} />
          </Field>
        </div>
        <Field label="Version or parallel" htmlFor="inv-variation" hint="Part of its name, like Refractor.">
          <input id="inv-variation" name="variation" defaultValue={filters.variation ?? ""} maxLength={120} className={INPUT_CLASS} />
        </Field>
        <Field label="Version answer" htmlFor="inv-version">
          <select id="inv-version" name="version" defaultValue={filters.version ?? ""} className={INPUT_CLASS}>
            <option value="">Any</option>
            <option value="not_sure">Version not sure</option>
          </select>
        </Field>
        <fieldset className="flex flex-col">
          <legend className="pb-1 text-sm font-semibold">Only show</legend>
          <Check id="inv-rookie" name="rookie" label="Rookies" on={filters.rookie === true} />
          {(Object.keys(MARK_LABELS) as (keyof typeof MARK_LABELS)[]).map((k) => (
            <Check key={k} id={`inv-${k}`} name={k} label={MARK_LABELS[k]} on={filters[k] === true} />
          ))}
        </fieldset>
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
      </FilterSheet>
      {active.length > 0 ? <p className="text-sm text-muted">Filters on: {active.join(", ")}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        <Button type="submit">Search</Button>
        <LinkButton href={action} variant="secondary">Clear all</LinkButton>
      </div>
    </form>
    </>
  );
}

function Check({ id, name, label, on }: { id: string; name: string; label: string; on: boolean }) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-base font-semibold">
      <input id={id} name={name} type="checkbox" value="1" defaultChecked={on} className="size-6 accent-accent" />
      {label}
    </label>
  );
}
