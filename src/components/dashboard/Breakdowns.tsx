import Link from "next/link";
import { Card } from "@/components/ui";
import type { BreakdownBy, GroupStat } from "@/lib/items/stats";
import type { SetStat } from "@/lib/sets/view";
import { SPORT_LABELS } from "@/lib/items/labels";
import { formatCents } from "@/lib/money";
import type { Sport } from "@/db/schema";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const rowClass = "flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2";

/** Where a row leads: the Inventory list filtered that way. */
export function breakdownHref(by: BreakdownBy, label: string): string {
  return `/items?${new URLSearchParams({ [by]: label }).toString()}`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <details className="rounded-2xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-4 font-semibold">
        <span>{title}</span>
        {hint ? <span className="text-sm font-normal text-muted">{hint}</span> : null}
      </summary>
      <div className="flex flex-col gap-1 px-3 pb-3">{children}</div>
    </details>
  );
}

function Rows({ by, rows }: { by: BreakdownBy; rows: GroupStat[] }) {
  if (rows.length === 0) return <p className="px-1 py-2 text-sm text-muted">Nothing to show yet.</p>;
  return (
    <>
      {rows.map((r) => (
        <Link key={r.label} href={breakdownHref(by, r.label)} className={rowClass}>
          <span className="min-w-0">
            <span className="block font-semibold break-words">{by === "sport" ? SPORT_LABELS[r.label as Sport] ?? r.label : r.label}</span>
            <span className="block text-sm text-muted">{plural(r.units, "unit", "units")}</span>
          </span>
          <span className="tabular shrink-0 font-semibold">{formatCents(r.valueCents)}</span>
        </Link>
      ))}
    </>
  );
}

/** Home: totals by sport, player, team and set, raw against graded, and the unpriced count. Each section starts closed. */
/** "By set": each row opens its set page (owned, missing and wanted cards). */
function SetRows({ rows }: { rows: SetStat[] }) {
  if (rows.length === 0) return <p className="px-1 py-2 text-sm text-muted">Nothing to show yet.</p>;
  return (
    <>
      {rows.map((r) => (
        <Link key={r.key} href={`/sets/${r.key}`} className={rowClass}>
          <span className="min-w-0">
            <span className="block font-semibold break-words">{r.label}</span>
            <span className="block text-sm text-muted">{plural(r.units, "unit", "units")}</span>
          </span>
          <span className="tabular shrink-0 font-semibold">{formatCents(r.valueCents)}</span>
        </Link>
      ))}
      <Link href="/sets" className="inline-flex min-h-11 items-center px-1 font-semibold text-accent">See all sets</Link>
    </>
  );
}

export function Breakdowns({ sports, players, teams, sets, graded, raw, noPrice, gone }: {
  sports: GroupStat[]; players: GroupStat[]; teams: GroupStat[]; sets: SetStat[];
  graded: GroupStat; raw: GroupStat; noPrice: number; gone: number;
}) {
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="pb-1 text-lg font-semibold">Break it down</h2>
      <Section title="By sport"><Rows by="sport" rows={sports} /></Section>
      <Section title="By player" hint="Top 10"><Rows by="player" rows={players} /></Section>
      <Section title="By team" hint="Top 10"><Rows by="team" rows={teams} /></Section>
      <Section title="By set" hint="Top 10"><SetRows rows={sets} /></Section>
      <Section title="Raw against graded">
        <Link href="/items?grading=raw" className={rowClass}>
          <span><span className="block font-semibold">Raw cards</span><span className="block text-sm text-muted">{plural(raw.units, "unit", "units")}</span></span>
          <span className="tabular font-semibold">{formatCents(raw.valueCents)}</span>
        </Link>
        <Link href="/items?grading=graded" className={rowClass}>
          <span><span className="block font-semibold">Graded</span><span className="block text-sm text-muted">{plural(graded.units, "unit", "units")}</span></span>
          <span className="tabular font-semibold">{formatCents(graded.valueCents)}</span>
        </Link>
      </Section>
      <Link href="/items?value=none" className={rowClass}>
        <span className="font-semibold">No price yet</span>
        <span className="tabular font-semibold">{noPrice.toLocaleString("en-US")}</span>
      </Link>
      {gone > 0 ? (
        <Link href="/items?status=gone" className={rowClass}>
          <span className="font-semibold">Sold and removed</span>
          <span className="tabular font-semibold">{gone.toLocaleString("en-US")}</span>
        </Link>
      ) : null}
    </Card>
  );
}
