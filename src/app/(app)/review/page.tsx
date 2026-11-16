import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { DeleteFailedScans } from "@/components/items/DeleteFailedScans";
import { CatalogCandidates } from "@/components/items/CatalogCandidates";
import { ItemRow } from "@/components/items/ItemRow";
import { ReviewRowActions } from "@/components/items/ReviewRowActions";
import { Card, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { requireOwner } from "@/lib/auth/guard";
import { scans } from "@/db/schema";
import { findDuplicateMatches, MERGE_MESSAGES, MERGE_PROBLEMS, reviewCount, reviewItems } from "@/lib/items/duplicates";
import { DuplicateNotice } from "@/components/items/DuplicateNotice";
import { summarize } from "@/lib/scans/view";
import { NOT_CHECKED_LINES } from "@/lib/catalog/candidates";
import { reviewCatalogView } from "@/lib/catalog/pick";
import { SerialAsk } from "@/components/items/SerialAsk";
import { RookieAsk } from "@/components/items/RookieAsk";
import { rookieAsk } from "@/lib/items/rookie";
import { parseSuggestion } from "@/lib/items/serial";

export const metadata = { title: "Review" };

const LIMIT = 100;

const noticeSchema = z.object({
  merge: z.enum(MERGE_PROBLEMS).optional().catch(undefined),
  cleared: z.coerce.number().int().min(0).max(1_000_000).optional().catch(undefined),
});

type Params = Record<string, string | string[] | undefined>;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireOwner();
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const notice = noticeSchema.parse({ merge: one(raw.merge), cleared: one(raw.cleared) });
  const db = getDb();
  const failedScans = db.select({ n: count() }).from(scans).where(eq(scans.status, "failed")).get()?.n ?? 0;
  const total = reviewCount(db);
  const rows = reviewItems(LIMIT, db);
  const summaries = summarize(rows, db);
  const now = new Date();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const catalogViews = new Map(rows.map((r) => [r.id, reviewCatalogView(r, db, now)]));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Review"
        subtitle={total === 0 ? "Nothing waiting" : `${total} ${total === 1 ? "item needs" : "items need"} a quick look`}
      />
      {notice.merge ? <div role="alert"><Notice tone="danger">{MERGE_MESSAGES[notice.merge]}</Notice></div> : null}
      {notice.cleared !== undefined ? (
        <Notice tone="accent">{notice.cleared === 1 ? "Deleted 1 failed scan." : `Deleted ${notice.cleared} failed scans.`}</Notice>
      ) : null}
      {failedScans > 0 ? <Card className="p-3"><DeleteFailedScans count={failedScans} /></Card> : null}
      {total === 0 ? (
        <EmptyState
          title="All caught up"
          body="Scans the AI is unsure about will wait here for you."
          action={<LinkButton href="/scan">Scan a card</LinkButton>}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {summaries.map((item) => {
            const dup = findDuplicateMatches(item.id, db)[0] ?? null;
            const cat = catalogViews.get(item.id) ?? null;
            return (
              <li key={item.id}>
                <Card className="flex flex-col gap-3 p-3">
                  <ItemRow item={item} />
                  {dup ? <DuplicateNotice itemId={item.id} title={item.title} quantity={item.quantity} match={dup} /> : null}
                  {cat ? (
                    <CatalogCandidates
                      id={item.id} title={item.title} view={cat}
                      notCheckedLine={cat.reason ? NOT_CHECKED_LINES[cat.reason] : null}
                    />
                  ) : null}
                  {(() => {
                    const full = rowById.get(item.id);
                    const serial = full ? parseSuggestion(full.serialSuggested) : null;
                    const rookie = full ? rookieAsk(full) : null;
                    return (
                      <>
                        {serial ? <SerialAsk itemId={item.id} title={item.title} view={serial} /> : null}
                        {rookie ? <RookieAsk itemId={item.id} title={item.title} view={rookie} /> : null}
                      </>
                    );
                  })()}
                  <ReviewRowActions id={item.id} title={item.title} />
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {total > LIMIT ? <p className="text-sm text-muted">Showing the oldest {LIMIT}. The rest will show up as you clear these.</p> : null}
    </div>
  );
}
