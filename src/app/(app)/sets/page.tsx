import Link from "next/link";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth/guard";
import { SPORT_LABELS } from "@/lib/items/labels";
import { cardsWithoutSet, listOwnedSets, ownedLine } from "@/lib/sets/view";

export const metadata = { title: "Sets" };
export const dynamic = "force-dynamic";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Every set the owner has cards from, built from the owner's own cards (no outside call). */
export default async function SetsPage() {
  await requireOwner();
  const sets = listOwnedSets();
  const noYear = cardsWithoutSet();
  if (sets.length === 0) {
    return (
      <>
        <PageHeader title="Sets" />
        <EmptyState
          title="No sets yet"
          body="A card shows up in a set once it has a year and a brand. Scan a card or add one by hand."
          action={<LinkButton href="/scan">Scan a card</LinkButton>}
        />
      </>
    );
  }
  const sports = [...new Set(sets.map((s) => s.sport))];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Sets" subtitle={`${plural(sets.length, "set", "sets")} you have cards from. Open one to see what you are missing.`} />
      {sports.map((sport) => (
        <Card key={sport ?? "none"} className="flex flex-col gap-1">
          <h2 className="pb-1 text-lg font-semibold">{sport ? SPORT_LABELS[sport] : "Sport not known"}</h2>
          {sets.filter((s) => s.sport === sport).map((s) => (
            <Link key={s.key} href={`/sets/${s.key}`} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block font-semibold break-words">{s.title}</span>
                <span className="block text-sm text-muted">
                  {ownedLine(s.owned, s.inReview)}
                </span>
              </span>
              <span className="tabular shrink-0 text-sm font-semibold">
                {s.percent != null ? `${s.percent}%` : s.hasChecklist ? "List kept" : ""}
              </span>
            </Link>
          ))}
        </Card>
      ))}
      {noYear > 0 ? (
        <p className="text-sm text-muted">
          {plural(noYear, "card has", "cards have")} no year or brand, so {noYear === 1 ? "it is" : "they are"} not in a set.{" "}
          <Link href="/items?kind=card" className="inline-flex min-h-11 items-center font-semibold text-accent">See your cards</Link>
        </p>
      ) : null}
    </div>
  );
}
