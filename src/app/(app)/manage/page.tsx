import { InventoryFilters } from "@/components/items/InventoryFilters";
import { filterKey, filterParams, selectionFilters } from "@/components/manage/filter-url";
import { ManageScreen, type ManageRow } from "@/components/manage/ManageScreen";
import { UndoNotice } from "@/components/manage/UndoNotice";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { items, locations } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { latestUndoable } from "@/lib/items/bulk";
import { inventoryFilterSchema, listItems } from "@/lib/items/query";
import { effectiveValueCents, formatCents } from "@/lib/money";
import { thumbsFor } from "@/lib/scans/view";
import { count, isNotNull } from "drizzle-orm";

export const metadata = { title: "Manage records" };

type Params = Record<string, string | string[] | undefined>;

export default async function ManagePage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireOwner();
  const filters = inventoryFilterSchema.parse(await searchParams);
  const db = getDb();
  const result = listItems(filters, db);
  const locationList = db.select({ id: locations.id, name: locations.name }).from(locations).orderBy(locations.name).all();
  const names = new Map(locationList.map((l) => [l.id, l.name]));
  const thumbs = thumbsFor(result.rows.map((r) => r.id), db);
  const rows: ManageRow[] = result.rows.map((r) => {
    const v = effectiveValueCents(r);
    return {
      id: r.id, title: r.title, year: r.year, brand: r.brand, cardNumber: r.cardNumber, player: r.player, team: r.team,
      location: r.locationId == null ? null : names.get(r.locationId) ?? null,
      value: v == null ? "No value yet" : formatCents(v), needsReview: r.status === "needs_review", thumb: thumbs.get(r.id) ?? null,
    };
  });
  const op = latestUndoable(db);
  const undo = op ? {
    id: op.id, summary: op.summary,
    madeAt: op.at.getTime(),
  } : null;
  // Reads deleted rows on purpose: only to count what is in Recently deleted.
  const inBin = db.select({ n: count() }).from(items).where(isNotNull(items.deletedAt)).get()?.n ?? 0;

  const href = (page: number) => {
    const sp = filterParams(filters);
    sp.set("page", String(page));
    return `/manage?${sp.toString()}`;
  };
  const backQs = filterParams(filters).toString();

  return (
    <>
      <PageHeader title="Manage records" subtitle={`${result.total.toLocaleString("en-US")} ${result.total === 1 ? "item" : "items"} match`} />
      <div className="grid grid-cols-2 gap-3 pb-4">
        <LinkButton href={backQs ? `/items?${backQs}` : "/items"} variant="secondary">Back to Inventory</LinkButton>
        <LinkButton href="/manage/deleted" variant="secondary">Recently deleted{inBin > 0 ? ` (${inBin.toLocaleString("en-US")})` : ""}</LinkButton>
      </div>
      <InventoryFilters filters={filters} locations={locationList} action="/manage" />
      {result.total === 0 ? (
        <>
          <UndoNotice offer={undo} message={null} />
          <EmptyState title="No matches" body="Nothing in your collection fits these filters."
            action={<LinkButton href="/manage" variant="secondary">Clear filters</LinkButton>} />
        </>
      ) : (
        <ManageScreen
          rows={rows} total={result.total} page={result.page} pageCount={result.pageCount}
          pageLinks={{ prev: result.page > 1 ? href(result.page - 1) : null, next: result.page < result.pageCount ? href(result.page + 1) : null }}
          filterKey={filterKey(filters)} filters={selectionFilters(filters)} locations={locationList} undo={undo}
        />
      )}
    </>
  );
}
