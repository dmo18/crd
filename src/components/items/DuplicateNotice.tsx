import Link from "next/link";
import { Button, Notice } from "@/components/ui";
import { findDuplicates } from "@/lib/items/duplicates";
import { mergeDuplicateAction } from "@/lib/items/review-actions";

export function DuplicateNotice({ itemId }: { itemId: number }) {
  const [existing] = findDuplicates(itemId);
  if (!existing) return null;
  return (
    <Notice tone="accent">
      <div className="flex flex-col gap-2">
        <p>
          You already have this card:{" "}
          <Link href={`/items/${existing.id}`} className="font-semibold underline">{existing.title}</Link>{" "}
          (quantity {existing.quantity}).
        </p>
        <form action={mergeDuplicateAction}>
          <input type="hidden" name="sourceId" value={itemId} />
          <input type="hidden" name="targetId" value={existing.id} />
          <Button type="submit" variant="secondary" className="w-full">Combine them</Button>
        </form>
      </div>
    </Notice>
  );
}
