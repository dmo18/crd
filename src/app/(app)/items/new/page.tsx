import { asc } from "drizzle-orm";
import Link from "next/link";
import { ItemForm } from "@/components/items/ItemForm";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { ITEM_KINDS, locations, type ItemKind } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "Add by hand" };

const KIND_LABELS: Record<ItemKind, string> = { card: "A card", sealed: "Sealed pack or box", bulk: "A bulk lot" };

export default async function NewItemPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const raw = (await searchParams).kind;
  const asked = Array.isArray(raw) ? raw[0] : raw;
  const kind: ItemKind = (ITEM_KINDS as readonly string[]).includes(asked ?? "") ? (asked as ItemKind) : "card";
  const options = getDb().select({ id: locations.id, name: locations.name }).from(locations).orderBy(asc(locations.name)).all();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Add by hand" subtitle="Fill in what you know. A player, a set or a description is enough. You can add more later." />
      <nav aria-label="What are you adding?" className="flex flex-col gap-2">
        <p className="text-sm font-semibold">What are you adding?</p>
        <ul className="grid grid-cols-3 gap-2">
          {ITEM_KINDS.map((k) => (
            <li key={k}>
              <Link
                href={`/items/new?kind=${k}`} aria-current={k === kind ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center rounded-xl border px-2 text-center text-sm font-semibold ${k === kind ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-2 text-text"}`}
              >
                {KIND_LABELS[k]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {/* Keyed by kind so the form starts fresh when the kind changes. */}
      <ItemForm key={kind} create={kind} locations={options} />
      <p className="text-sm text-muted">
        Want to look it up instead? <Link href="/search" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Search the catalog</Link>
      </p>
    </div>
  );
}
