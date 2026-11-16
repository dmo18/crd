import { count, asc, isNotNull } from "drizzle-orm";
import { DeletedList, type BinRow } from "@/components/manage/DeletedList";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { daysLeft, timeLeftText } from "@/lib/items/bin";
import { thumbsFor } from "@/lib/scans/view";

export const metadata = { title: "Recently deleted" };

const PER_PAGE = 40;

export default async function DeletedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const raw = (await searchParams).page;
  const one = Array.isArray(raw) ? raw[0] : raw;
  const wanted = one && /^\d{1,5}$/.test(one) ? Number(one) : 1;
  const db = getDb();
  // Reads deleted rows on purpose: this screen is the bin.
  const total = db.select({ n: count() }).from(items).where(isNotNull(items.deletedAt)).get()?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(wanted, 1), pageCount);
  const found = db.select().from(items).where(isNotNull(items.deletedAt))
    .orderBy(asc(items.deletedAt), asc(items.id)).limit(PER_PAGE).offset((page - 1) * PER_PAGE).all();
  const thumbs = thumbsFor(found.map((r) => r.id), db);
  const rows: BinRow[] = found.map((r) => ({
    id: r.id, title: r.title, thumb: thumbs.get(r.id) ?? null,
    deletedOn: r.deletedAt!.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    left: timeLeftText(daysLeft(r.deletedAt!)).replace("It is removed for good in ", "").replace(/\.$/, "").replace("It will be removed for good soon", "Removed soon"),
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Recently deleted" subtitle={`${total.toLocaleString("en-US")} ${total === 1 ? "item" : "items"}. Each stays here for 30 days, then is removed for good.`} />
      <LinkButton href="/manage" variant="secondary">Back to Manage records</LinkButton>
      {total === 0 ? (
        <EmptyState title="Nothing deleted" body="Items you delete wait here for 30 days, so you can bring them back." />
      ) : (
        <DeletedList
          rows={rows} total={total} page={page} pageCount={pageCount}
          prev={page > 1 ? `/manage/deleted?page=${page - 1}` : null}
          next={page < pageCount ? `/manage/deleted?page=${page + 1}` : null}
        />
      )}
    </div>
  );
}
