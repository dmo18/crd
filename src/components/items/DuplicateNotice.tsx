import Link from "next/link";
import { Button, LinkButton, Notice } from "@/components/ui";
import type { Db } from "@/db";
import { findDuplicateMatches, serialText, type DuplicateMatch } from "@/lib/items/duplicates";
import { keepApartAction, mergeDuplicateAction } from "@/lib/items/review-actions";

/**
 * The duplicate question with three answers (PLAN.md Milestone 11,
 * "Design: duplicates"). Shown on the item page and on each Review row.
 * Nothing is combined or remembered until the owner taps an answer.
 */
export function DuplicateNotice({ itemId, title, quantity, db, match }: { itemId: number; title: string; quantity: number; db?: Db; match?: DuplicateMatch | null }) {
  const found = match === undefined ? findDuplicateMatches(itemId, db)[0] ?? null : match;
  if (!found) return null;
  const old = found.item;
  // The older record (lower id) is always the one kept; the server decides the same way.
  const thisIsOlder = itemId < old.id;
  const keepId = Math.min(itemId, old.id);
  const goneId = Math.max(itemId, old.id);
  const oldLink = <Link href={`/items/${old.id}`} className="font-semibold underline">{old.title}</Link>;
  const serial = found.kind === "same_numbered" ? serialText(old) : null;
  // The other one is still in Review too: only a question (it is never combined by itself).
  const waiting = old.status === "needs_review";

  return (
    <Notice tone={found.kind === "maybe" ? "warn" : "accent"}>
      <div className="flex flex-col gap-3">
        {found.kind === "same" ? (
          thisIsOlder
            ? <p>This card was entered again later: {oldLink} (quantity {old.quantity}).</p>
            : <p>You already have this card: {oldLink} (quantity {old.quantity}).</p>
        ) : waiting ? (
          <p>This may be the same card as another one still waiting in Review: {oldLink}. If you scanned it twice, delete one of them. If you have two copies, keep both.</p>
        ) : found.kind === "maybe" ? (
          <p>This may be a card you already have: {oldLink}. The version differs or is open, or only one of them has a grade.</p>
        ) : (
          <p>This looks like the very same numbered card{serial ? ` (${serial})` : ""} entered twice: {oldLink}.</p>
        )}

        {found.kind !== "maybe" ? (
          <form action={mergeDuplicateAction} className="flex flex-col gap-2">
            <input type="hidden" name="sourceId" value={goneId} />
            <input type="hidden" name="targetId" value={keepId} />
            {thisIsOlder ? (
              <p>
                {found.kind === "same"
                  ? `This one then has a quantity of ${quantity + old.quantity}. `
                  : `This one keeps its quantity of ${quantity}. `}
                It keeps its own details. The photos of the newer record move to this one, then the newer record is removed.
              </p>
            ) : (
              <p>
                {found.kind === "same"
                  ? `The old one then has a quantity of ${old.quantity + quantity}. `
                  : `The old one keeps its quantity of ${old.quantity}. `}
                It keeps its own details. The photos of this record move to the old one, then this record is removed.
              </p>
            )}
            <Button type="submit" variant="secondary" className="w-full" aria-label={found.kind === "same" ? (thisIsOlder ? `Count the newer one with ${title}` : `Count ${title} with the old one`) : `Remove the double entry ${thisIsOlder ? old.title : title}`}>
              {found.kind === "same" ? (thisIsOlder ? "Count the newer one with this" : "Count it with the old one") : (thisIsOlder ? "Remove the newer double entry" : "Remove this double entry")}
            </Button>
          </form>
        ) : null}

        <form action={keepApartAction}>
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="otherId" value={old.id} />
          <Button type="submit" variant="secondary" className="w-full" aria-label={`Keep ${title} and ${old.title} both as they are`}>
            Keep both as they are
          </Button>
        </form>

        <LinkButton href={`/items/${old.id}#edit`} variant="secondary" className="w-full" aria-label={`Open ${old.title} to fix it`}>
          {waiting ? "Open the other one" : "Open the old one to fix it"}
        </LinkButton>
      </div>
    </Notice>
  );
}
