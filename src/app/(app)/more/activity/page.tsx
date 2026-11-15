import Link from "next/link";
import { z } from "zod";
import { LocalTime } from "@/components/activity/LocalTime";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth/guard";
import { describeAudit, outcomeLabel, outcomeTone } from "@/lib/audit/labels";
import { AUDIT_FILTERS, listAudit, type AuditFilter } from "@/lib/audit/store";

export const metadata = { title: "Activity" };

type Params = Record<string, string | string[] | undefined>;

const paramsSchema = z.object({
  show: z.enum(AUDIT_FILTERS).catch("security"),
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
});

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const FILTER_LABELS: Record<AuditFilter, string> = { security: "Security only", all: "Everything" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireOwner();
  const raw = await searchParams;
  const { show, page } = paramsSchema.parse({ show: one(raw.show), page: one(raw.page) });
  const result = listAudit(show, page);
  const href = (s: AuditFilter, p = 1) => `/more/activity?show=${s}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Activity"
        subtitle="Newest first. Kept for one year."
        action={<LinkButton href="/more" variant="ghost">Back</LinkButton>}
      />

      <nav aria-label="Show" className="grid grid-cols-2 gap-2">
        {AUDIT_FILTERS.map((f) => (
          <Link
            key={f}
            href={href(f)}
            aria-current={f === show ? "page" : undefined}
            className={
              "inline-flex min-h-11 items-center justify-center rounded-xl border px-3 text-base font-semibold " +
              (f === show ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-2 text-text")
            }
          >
            {FILTER_LABELS[f]}
          </Link>
        ))}
      </nav>

      {result.total === 0 ? (
        <EmptyState
          title="Nothing yet"
          body={show === "security" ? "Sign-ins and password changes will show up here." : "Sign-ins, downloads and deletions will show up here."}
        />
      ) : (
        <>
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {result.rows.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-base break-words">{describeAudit(row)}</p>
                    {row.outcome !== "ok" ? <Badge tone={outcomeTone(row.outcome)}>{outcomeLabel(row.outcome)}</Badge> : null}
                  </div>
                  <p className="text-sm text-muted"><LocalTime ms={row.at.getTime()} /></p>
                </li>
              ))}
            </ul>
          </Card>
          {result.pages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              {result.page > 1 ? <LinkButton href={href(show, result.page - 1)} variant="secondary">Newer</LinkButton> : <span className="min-w-24" />}
              <p className="text-sm text-muted">Page {result.page} of {result.pages}</p>
              {result.page < result.pages ? <LinkButton href={href(show, result.page + 1)} variant="secondary">Older</LinkButton> : <span className="min-w-24" />}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
