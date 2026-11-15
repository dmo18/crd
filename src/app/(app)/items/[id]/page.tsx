import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { DeleteItemButton } from "@/components/items/DeleteItemButton";
import { ItemBadges } from "@/components/items/ItemRow";
import { ItemForm } from "@/components/items/ItemForm";
import { Button, Card, Notice } from "@/components/ui";
import { getDb } from "@/db";
import { images, items, locations } from "@/db/schema";
import { confirmItemAction } from "@/lib/items/actions";
import { confidenceLabel, VALUE_SOURCE_LABELS } from "@/lib/items/labels";
import { parsePullList } from "@/lib/items/from-recognition";
import { effectiveValueCents, formatCents } from "@/lib/money";

export const metadata = { title: "Item" };

const ROLE_NAMES = { front: "Front", back: "Back", crop: "Close-up", source: "Original photo" } as const;
const ROLE_ORDER = { crop: 0, front: 1, back: 2, source: 3 } as const;

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  if (!/^\d{1,9}$/.test(rawId)) notFound();
  const id = Number(rawId);
  const db = getDb();
  const item = db.select().from(items).where(eq(items.id, id)).get();
  if (!item) notFound();
  const photos = db.select().from(images).where(eq(images.itemId, id)).orderBy(asc(images.id)).all()
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const location = item.locationId == null ? null
    : db.select().from(locations).where(eq(locations.id, item.locationId)).get();

  const value = effectiveValueCents(item);
  const source = item.manualValueCents != null ? "manual" : item.valueSource;
  const hasRange = item.estLowCents != null && item.estHighCents != null;
  const pulls = parsePullList(item.pullList);
  const notes: [string, string][] = [];
  if (item.rarityNotes) notes.push(["About its rarity", item.rarityNotes]);
  if (item.conditionNotes) notes.push(["About its condition", item.conditionNotes]);
  if (item.worthGrading != null) {
    notes.push(["Worth grading?", `${item.worthGrading ? "Yes" : "No"}${item.gradingNotes ? `. ${item.gradingNotes}` : ""}`]);
  } else if (item.gradingNotes) {
    notes.push(["Grading", item.gradingNotes]);
  }
  if (item.aiNotes) notes.push(["Other notes from the AI", item.aiNotes]);

  return (
    <div className="flex flex-col gap-5">
      {photos.length > 0 ? (
        <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
          {photos.map((p) => (
            <li key={p.id} className="w-56 shrink-0 snap-start">
              <a href={`/api/images/${p.file}`} target="_blank" rel="noopener noreferrer" className="flex min-h-11 flex-col gap-1">
                {/* Plain img: photos come from our own /api/images route. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/images/${p.thumbFile}`} alt={`${ROLE_NAMES[p.role]} photo of ${item.title}`} className="aspect-[3/4] w-full rounded-xl bg-surface-2 object-cover" />
                <span className="text-sm text-muted">{ROLE_NAMES[p.role]} (opens full size)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-balance break-words">{item.title}</h1>
        <ItemBadges item={item} />
        <p className="text-sm text-muted">
          {confidenceLabel(item.confidence)}
          {location ? ` · Stored in ${location.name}` : ""}
        </p>
      </header>

      {item.status === "needs_review" ? (
        <div className="flex flex-col gap-3">
          <Notice tone="warn">The AI was not sure about this one. Check the details, fix anything wrong, then confirm.</Notice>
          <form action={confirmItemAction}>
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" className="w-full">Looks right, confirm</Button>
          </form>
        </div>
      ) : null}

      <Card className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted">Value</h2>
        <p className="text-3xl font-bold">{formatCents(value)}</p>
        {hasRange ? <p className="text-sm">Range: {formatCents(item.estLowCents)} to {formatCents(item.estHighCents)}</p> : null}
        {source ? <p className="text-sm text-muted">Source: {VALUE_SOURCE_LABELS[source]}</p> : null}
        {item.valueBasis ? <p className="text-sm">{item.valueBasis}</p> : null}
        <p className="pt-1 text-xs text-muted">Estimates are a guide, not an appraisal.</p>
      </Card>

      {item.kind === "sealed" ? <Notice tone="accent">Keep it sealed. Sealed product is usually worth more unopened.</Notice> : null}

      {notes.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">What the AI noticed</h2>
          {notes.map(([label, body]) => (
            <div key={label}>
              <h3 className="text-sm font-semibold">{label}</h3>
              <p className="text-sm text-muted">{body}</p>
            </div>
          ))}
        </section>
      ) : null}

      {item.kind !== "card" && pulls.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{item.kind === "sealed" ? "Cards to look for" : "Worth pulling out and scanning"}</h2>
          <ul className="list-disc pl-5 text-sm">
            {pulls.map((name, i) => <li key={`${i}-${name}`}>{name}</li>)}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Edit details</h2>
        <ItemForm item={item} />
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-5">
        <h2 className="text-lg font-semibold">Remove</h2>
        <DeleteItemButton id={item.id} />
      </section>
    </div>
  );
}
