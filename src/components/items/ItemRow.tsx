import Link from "next/link";
import { Badge } from "@/components/ui";
import { confidenceLabel, KIND_LABELS, RARITY_LABELS } from "@/lib/items/labels";
import { CHOOSE_VERSION_LINE } from "@/lib/items/value-line";
import { formatCents } from "@/lib/money";
import type { ItemSummary } from "@/lib/scans/view";

type BadgeInfo = {
  status: ItemSummary["status"];
  isRookie: boolean;
  rarityTier: ItemSummary["rarityTier"];
  kind: ItemSummary["kind"];
};

/** The small tags shown next to an item, shared by lists and the item page. */
export function ItemBadges({ item }: { item: BadgeInfo }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.status === "needs_review" ? <Badge tone="warn">Needs review</Badge> : null}
      {item.isRookie ? <Badge tone="gold">Rookie</Badge> : null}
      {item.rarityTier === "key" || item.rarityTier === "grail" ? <Badge tone="gold">{RARITY_LABELS[item.rarityTier]}</Badge> : null}
      {item.kind !== "card" ? <Badge tone="accent">{KIND_LABELS[item.kind]}</Badge> : null}
    </div>
  );
}

function valueText(item: ItemSummary): string {
  if (item.waitingForVersion) return CHOOSE_VERSION_LINE;
  if (item.lowCents != null && item.highCents != null && item.lowCents !== item.highCents) {
    return `${formatCents(item.lowCents)} to ${formatCents(item.highCents)}`;
  }
  return item.valueCents != null ? `Est. ${formatCents(item.valueCents)}` : "No value yet";
}

export function ItemRow({ item }: { item: ItemSummary }) {
  return (
    <Link
      href={`/items/${item.id}`}
      className="flex min-h-11 items-center gap-3 rounded-2xl border border-border bg-surface p-3"
    >
      {item.thumb ? (
        // Plain img: photos come from our own /api/images route, already resized.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/images/${item.thumb}`} alt={`Photo of ${item.title}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold break-words">{item.title}</p>
        <ItemBadges item={item} />
        <p className="text-sm text-muted">
          {confidenceLabel(item.confidence)} <span aria-hidden="true">&middot;</span> {valueText(item)}
        </p>
      </div>
    </Link>
  );
}
