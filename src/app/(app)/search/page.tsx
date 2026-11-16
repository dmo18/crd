import { and, eq } from "drizzle-orm";
import { SearchScreen } from "@/components/catalog/SearchScreen";
import { LinkButton, Notice, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { items, SPORTS } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { liveItem } from "@/lib/items/live";

export const metadata = { title: "Search cards" };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireOwner();
  const params = await searchParams;
  let itemId: number | null = null;
  let itemTitle: string | null = null;
  let text = one(params.q).slice(0, 80);
  let sport = (SPORTS as readonly string[]).includes(one(params.sport)) ? one(params.sport) : "";
  let year = /^\d{4}$/.test(one(params.year)) ? one(params.year) : "";
  if (/^\d{1,9}$/.test(one(params.itemId))) {
    const item = getDb().select().from(items).where(and(eq(items.id, Number(one(params.itemId))), liveItem)).get();
    if (item && item.kind === "card") {
      itemId = item.id;
      itemTitle = item.title;
      if (!text) text = [item.year, item.brand, item.player].filter(Boolean).join(" ").slice(0, 80);
      if (!sport && item.sport) sport = item.sport;
      if (!year && item.year) year = String(item.year);
    }
  }
  return (
    <>
      <PageHeader title="Search cards" subtitle="Find a card in the catalog and add it to your collection." />
      <div className="flex flex-col gap-4">
        <SearchScreen initialText={text} initialSport={sport} initialYear={year} itemId={itemId} itemTitle={itemTitle} />
        <LinkButton href="/items/new" variant="secondary" className="w-full">Add a card by hand</LinkButton>
      </div>
    </>
  );
}
