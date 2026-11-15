import { asc, eq } from "drizzle-orm";
import { ItemRow } from "@/components/items/ItemRow";
import { ReviewRowActions } from "@/components/items/ReviewRowActions";
import { Button, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { requireOwner } from "@/lib/auth/guard";
import { items } from "@/db/schema";
import { findDuplicates, reviewCount } from "@/lib/items/duplicates";
import { mergeDuplicateAction } from "@/lib/items/review-actions";
import { summarize } from "@/lib/scans/view";

export const metadata = { title: "Review" };

const LIMIT = 100;

export default async function ReviewPage() {
  await requireOwner();
  const db = getDb();
  const total = reviewCount(db);
  const rows = db.select().from(items).where(eq(items.status, "needs_review"))
    .orderBy(asc(items.createdAt), asc(items.id)).limit(LIMIT).all();
  const summaries = summarize(rows, db);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Review"
        subtitle={total === 0 ? "Nothing waiting" : `${total} ${total === 1 ? "item needs" : "items need"} a quick look`}
      />
      {total === 0 ? (
        <EmptyState
          title="All caught up"
          body="Scans the AI is unsure about will wait here for you."
          action={<LinkButton href="/scan">Scan a card</LinkButton>}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {summaries.map((item) => {
            const dup = findDuplicates(item.id, db)[0];
            return (
              <li key={item.id}>
                <Card className="flex flex-col gap-3 p-3">
                  <ItemRow item={item} />
                  {dup ? (
                    <form action={mergeDuplicateAction} className="flex flex-col gap-2">
                      <input type="hidden" name="sourceId" value={item.id} />
                      <input type="hidden" name="targetId" value={dup.id} />
                      <p className="text-sm">You already have this card (quantity {dup.quantity}).</p>
                      <Button type="submit" variant="secondary" aria-label={`Add ${item.title} to the one you already have`}>
                        Add to existing
                      </Button>
                    </form>
                  ) : null}
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
