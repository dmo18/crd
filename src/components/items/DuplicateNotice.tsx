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
  const oldLink = <Link href={`/items/${old.id}`} className="font-semibold underline">{old.title}</Link>;
  const serial = found.kind === "same_numbered" ? serialText(old) : null;

  return (
    <Notice tone={found.kind === "maybe" ? "warn" : "accent"}>
      <div className="flex flex-col gap-3">
        {found.kind === "same" ? (
          <p>You already have this card: {oldLink} (quantity {old.quantity}).</p>
        ) : found.kind === "maybe" ? (
          <p>This may be a card you already have: {oldLink}. The version differs or is open, or only one of them has a grade.</p>
        ) : (
          <p>This looks like the very same numbered card{serial ? ` (${serial})` : ""} entered twice: {oldLink}.</p>
        )}

        {found.kind !== "maybe" ? (
          <form action={mergeDuplicateAction} className="flex flex-col gap-2">
            <input type="hidden" name="sourceId" value={itemId} />
            <input type="hidden" name="targetId" value={old.id} />
            <p>
              {found.kind === "same"
                ? `The old one then has a quantity of ${old.quantity + quantity}. `
                : `The old one keeps its quantity of ${old.quantity}. `}
              It keeps its own details. The photos of this record move to the old one, then this record is removed.
            </p>
            <Button type="submit" variant="secondary" className="w-full" aria-label={found.kind === "same" ? `Count ${title} with the old one` : `Remove the double entry ${title}`}>
              {found.kind === "same" ? "Count it with the old one" : "Remove this double entry"}
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
          Open the old one to fix it
        </LinkButton>
      </div>
    </Notice>
  );
}
