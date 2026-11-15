import Link from "next/link";
import { ValueChart } from "@/components/dashboard/ValueChart";
import { DecadeBars } from "@/components/dashboard/DecadeBars";
import { ItemRow } from "@/components/items/ItemRow";
import { Card, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { recognitionMode } from "@/lib/env";
import { requireOwner } from "@/lib/auth/guard";
import { decadeBreakdown, highlights, kindBreakdown, recentItems, topItems } from "@/lib/items/stats";
import { formatCents } from "@/lib/money";
import { summarize } from "@/lib/scans/view";
import { collectionTotals, getSnapshots, recordSnapshot } from "@/lib/valuation/snapshots";

export const dynamic = "force-dynamic";

const KIND_ROWS = [
  { kind: "card", label: "Cards" },
  { kind: "sealed", label: "Sealed" },
  { kind: "bulk", label: "Bulk lots" },
] as const;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const linkClass = "inline-flex min-h-11 items-center text-base font-semibold text-accent";

export default async function Home() {
  await requireOwner();
  try {
    recordSnapshot();
  } catch {
    // The chart just misses today if this fails; the page still works.
  }

  const totals = collectionTotals();
  if (totals.itemCount === 0) {
    return (
      <>
        <PageHeader title="Card Vault" />
        <EmptyState
          title="Start your collection"
          body="Take a photo of a card, a pack or a box and it will show up here."
          action={<LinkButton href="/scan">Scan your first card</LinkButton>}
        />
      </>
    );
  }

  const hl = highlights();
  const mode = recognitionMode();
  const kinds = kindBreakdown();
  const snapshots = getSnapshots(90);
  const top = summarize(topItems(5));
  const recent = summarize(recentItems(5));
  const decades = decadeBreakdown();
  const showDecades = decades.some((d) => d.label !== "Unknown");

  const tiles = [
    { label: "Rookies", count: hl.rookies, href: "/items?rookie=1" },
    { label: "Key cards", count: hl.keyCards, href: "/items?tier=key,grail" },
    { label: "Worth grading", count: hl.worthGrading, href: null },
    { label: "No value yet", count: hl.noValue, href: "/items?value=none" },
  ].filter((t) => t.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Card Vault" />

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted">Collection value</h2>
        <p className="tabular text-4xl font-bold break-words">{formatCents(totals.totalValueCents)}</p>
        <p className="text-sm text-muted">
          {plural(totals.itemCount, "item", "items")} · {plural(totals.unitCount, "card and product", "cards and products")}
        </p>
        {mode === "sample" ? <Notice tone="warn">These are sample cards for trying the app.</Notice> : null}
        {mode === "free" && hl.noValue > 0 ? (
          <Notice tone="accent">
            <Link href="/items?value=none&sort=newest" className="flex min-h-11 items-center font-semibold">
              {plural(hl.noValue, "item needs", "items need")} a value. Start with rookies and Hall of Famers.
            </Link>
          </Notice>
        ) : null}
      </Card>

      {hl.needsReview > 0 ? (
        <Notice tone="accent">
          <Link href="/review" className="flex min-h-11 items-center font-semibold">
            {plural(hl.needsReview, "item needs", "items need")} a quick look
          </Link>
        </Notice>
      ) : null}

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Value over time</h2>
        <ValueChart snapshots={snapshots} />
      </Card>

      <Card className="flex flex-col gap-1">
        <h2 className="pb-2 text-lg font-semibold">What you have</h2>
        {KIND_ROWS.map(({ kind, label }) => {
          const k = kinds.find((x) => x.kind === kind);
          return (
            <Link
              key={kind}
              href={`/items?kind=${kind}`}
              className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-muted">{plural(k?.units ?? 0, "unit", "units")}</span>
              </span>
              <span className="tabular font-semibold">{formatCents(k?.valueCents ?? 0)}</span>
            </Link>
          );
        })}
      </Card>

      {tiles.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Highlights</h2>
          <ul className="grid grid-cols-2 gap-2">
            {tiles.map((t) => {
              const inner = (
                <>
                  <span className="tabular block text-2xl font-bold">{t.count.toLocaleString("en-US")}</span>
                  <span className="block text-sm text-muted">{t.label}</span>
                </>
              );
              return (
                <li key={t.label}>
                  {t.href ? (
                    <Link href={t.href} className="flex min-h-11 flex-col justify-center rounded-xl bg-surface-2 p-3">
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex min-h-11 flex-col justify-center rounded-xl bg-surface-2 p-3">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {top.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Most valuable</h2>
          <div className="flex flex-col gap-2">
            {top.map((item) => <ItemRow key={item.id} item={item} />)}
          </div>
          <Link href="/items?sort=value_desc" className={linkClass}>See all by value</Link>
        </Card>
      ) : null}

      {showDecades ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">By decade</h2>
          <DecadeBars decades={decades} />
        </Card>
      ) : null}

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recently added</h2>
        <div className="flex flex-col gap-2">
          {recent.map((item) => <ItemRow key={item.id} item={item} />)}
        </div>
        <Link href="/items" className={linkClass}>See everything</Link>
      </Card>
    </div>
  );
}
