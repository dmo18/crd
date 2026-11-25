import { InventoryFilters } from "@/components/items/InventoryFilters";
import { ItemRow } from "@/components/items/ItemRow";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { requireOwner } from "@/lib/auth/guard";
import { locations } from "@/db/schema";
import { inventoryFilterSchema, listItems } from "@/lib/items/query";
import { formatCents } from "@/lib/money";
import { exportQuery, filterParams } from "@/components/manage/filter-url";
import { ExportLink } from "@/components/manage/ExportLink";
import { summarize } from "@/lib/scans/view";

export const metadata = { title: "Inventory" };

type Params = Record<string, string | string[] | undefined>;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireOwner();
  const params = await searchParams;
  const filters = inventoryFilterSchema.parse(params);
  const db = getDb();
  const result = listItems(filters, db);
  const locationList = db.select({ id: locations.id, name: locations.name }).from(locations).orderBy(locations.name).all();
  const cards = summarize(result.rows, db);

  const hasFilters = Boolean(
    filters.q || filters.kind || filters.sport || filters.status || filters.tier || filters.rookie ||
    filters.yearFrom != null || filters.yearTo != null || filters.location != null || filters.value != null ||
    filters.missing || filters.flag || filters.version,
  );
  const subtitle = [
    `${plural(result.total, "item", "items")}${hasFilters ? " matching" : ""}`,
    plural(result.totalUnits, "card or product", "cards and products"),
    formatCents(result.totalValueCents),
  ].join(" · ");

  // Keep every current setting when moving between pages.
  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const one = Array.isArray(v) ? v[0] : v;
      if (k !== "page" && one) sp.set(k, one);
    }
    sp.set("page", String(page));
    return `/items?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader title="Inventory" subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-2 pb-4 sm:grid-cols-2">
        <LinkButton href={`/manage${filterParams(filters).size ? `?${filterParams(filters).toString()}` : ""}`} variant="secondary" className="w-full">
          Select and edit
        </LinkButton>
        <ExportLink query={exportQuery(filters)} label="Export what I am looking at" />
      </div>
      <InventoryFilters filters={filters} locations={locationList} />
      {result.total === 0 ? (
        hasFilters ? (
          <EmptyState title="No matches" body="Nothing in your collection fits these filters."
            action={<LinkButton href="/items" variant="secondary">Clear filters</LinkButton>} />
        ) : (
          <EmptyState title="Nothing here yet" body="Scan a card, pack or box and it will show up here."
            action={
            <div className="flex w-full flex-col gap-2">
              <LinkButton href="/scan">Scan your first card</LinkButton>
              <LinkButton href="/search" variant="secondary">Search cards by words</LinkButton>
            </div>
          } />
        )
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {cards.map((item) => <li key={item.id}><ItemRow item={item} /></li>)}
          </ul>
          {result.pageCount > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-4">
              {result.page > 1 ? <LinkButton href={pageHref(result.page - 1)} variant="secondary">Previous</LinkButton> : <span className="min-w-24" />}
              <p className="text-sm text-muted">Page {result.page} of {result.pageCount}</p>
              {result.page < result.pageCount ? <LinkButton href={pageHref(result.page + 1)} variant="secondary">Next</LinkButton> : <span className="min-w-24" />}
            </nav>
          ) : null}
        </>
      )}
    </>
  );
}
