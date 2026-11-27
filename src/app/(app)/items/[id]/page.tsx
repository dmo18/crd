import { LocalTime } from "@/components/activity/LocalTime";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GradingAdvice } from "@/components/items/GradingAdvice";
import { PriceLinks } from "@/components/items/PriceLinks";
import { ValueTools } from "@/components/items/ValueTools";
import { CatalogBlock } from "@/components/catalog/CatalogBlock";
import { DuplicateNotice } from "@/components/items/DuplicateNotice";
import { PhotoUpload } from "@/components/items/PhotoUpload";
import { DeleteItemButton } from "@/components/items/DeleteItemButton";
import { ItemBadges } from "@/components/items/ItemRow";
import { ItemForm } from "@/components/items/ItemForm";
import { BackButton, OutcomeForms } from "@/components/items/OutcomeForm";
import { Button, Card, Notice } from "@/components/ui";
import { getDb } from "@/db";
import { images, items, locations, type Item } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { confirmItemAction, restoreItemAction } from "@/lib/items/actions";
import { daysLeft, timeLeftText } from "@/lib/items/bin";
import { checkNotice, confidenceLabel, valueSourceLabel } from "@/lib/items/labels";
import { fieldsToCheck, offerTrim } from "@/lib/catalog/sources";
import { holdReasons, linkedFacts } from "@/lib/catalog/pick";
import { FRONT_TWICE } from "@/lib/recognition/types";
import { parsePullList } from "@/lib/items/from-recognition";
import { recognitionMode } from "@/lib/env";
import { VersionPicker } from "@/components/catalog/VersionPicker";
import { versionView } from "@/lib/catalog/version-view";
import { CHOOSE_VERSION_LINE, shownValue } from "@/lib/items/value-line";
import { formatCents } from "@/lib/money";
import { SerialAsk } from "@/components/items/SerialAsk";
import { RookieAsk } from "@/components/items/RookieAsk";
import { rookieAsk } from "@/lib/items/rookie";
import { parseSuggestion } from "@/lib/items/serial";
import { keyOfFields, setLabel } from "@/lib/sets/identity";

export const metadata = { title: "Item" };

// A many-cards scan's cut-out of a card (role crop) is that card's front.
const ROLE_NAMES = { front: "Front", back: "Back", crop: "Front", source: "Original photo" } as const;
const ROLE_ORDER = { crop: 0, front: 1, back: 2, source: 3 } as const;

/** The two questions a scan leaves: serial number and rookie card. They show only when there is something to answer. */
function AskBlock({ item, catalogRookie }: { item: Item; catalogRookie: boolean }) {
  const serial = parseSuggestion(item.serialSuggested);
  // A clean catalog entry that marks it a rookie card is only a suggestion in the question (S1a rule F).
  const rookie = rookieAsk(item, catalogRookie ? ["RC"] : []);
  if (!serial && !rookie) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Questions about this card">
      {serial ? <SerialAsk itemId={item.id} title={item.title} view={serial} /> : null}
      {rookie ? <RookieAsk itemId={item.id} title={item.title} view={rookie} /> : null}
    </section>
  );
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id: rawId } = await params;
  if (!/^\d{1,9}$/.test(rawId)) notFound();
  const id = Number(rawId);
  const db = getDb();
  // Reads deleted rows on purpose: a deleted item shows only its Restore step.
  const item = db.select().from(items).where(eq(items.id, id)).get();
  if (!item) notFound();
  if (item.deletedAt) {
    const left = daysLeft(item.deletedAt);
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-balance break-words">{item.title}</h1>
        <Card className="flex flex-col gap-3">
          <p className="font-semibold">This was deleted on <LocalTime ms={item.deletedAt.getTime()} />.</p>
          <p className="text-sm text-muted">
            {timeLeftText(left)} Restore it to bring it back with its photos and value history.
          </p>
          <form action={restoreItemAction}>
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" className="w-full">Restore</Button>
          </form>
        </Card>
      </div>
    );
  }
  if (item.status === "sold" || item.status === "removed") {
    const thumb = db.select().from(images).where(eq(images.itemId, id)).orderBy(asc(images.id)).limit(1).get();
    const sold = item.status === "sold";
    const noun = item.kind === "card" ? "card" : "item";
    return (
      <div className="flex flex-col gap-4">
        {thumb ? (
          // Plain img: photos come from our own /api/images route.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/images/${thumb.thumbFile}`} alt={`Photo of ${item.title}`} className="mx-auto aspect-[3/4] max-h-72 rounded-xl bg-surface-2 object-contain" />
        ) : null}
        <h1 className="text-2xl font-bold text-balance break-words">{item.title}</h1>
        <ItemBadges item={item} />
        <Card className="flex flex-col gap-3">
          <p className="font-semibold">{sold ? `This ${noun} was sold.` : `This ${noun} was removed from your collection.`}</p>
          {sold ? (
            <p className="text-sm">
              {item.soldPriceCents != null ? `Sold for ${formatCents(item.soldPriceCents)}. ` : "No sale price was written down. "}
              {/* The day is stored as midnight UTC, so it is shown in UTC: the same day the owner picked. */}
              {item.soldAt ? `Sold on ${item.soldAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.` : null}
            </p>
          ) : null}
          <p className="text-sm text-muted">It is not counted in your totals, lists or duplicate checks. Put it back if this was a mistake.</p>
          <BackButton id={item.id} />
        </Card>
        <section className="flex flex-col gap-2 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">Delete</h2>
          <DeleteItemButton id={item.id} />
        </section>
      </div>
    );
  }
  const photos = db.select().from(images).where(eq(images.itemId, id)).orderBy(asc(images.id)).all()
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const hasFront = photos.some((p) => p.role === "front" || p.role === "crop");
  const hasBack = photos.some((p) => p.role === "back");
  const location = item.locationId == null ? null
    : db.select().from(locations).where(eq(locations.id, item.locationId)).get();

  const { cents: value, waitingForVersion, ownersValue } = shownValue(item);
  const setKey = item.kind === "card" ? keyOfFields(item) : null;
  const estimateHidden = item.versionState === "not_sure";
  const mode = recognitionMode();
  const source = item.manualValueCents != null ? "manual" : item.valueSource;
  // The range and basis belong to the estimate: hidden when the owner's own value is shown.
  const hasRange = source !== "manual" && item.estLowCents != null && item.estHighCents != null;
  const pulls = parsePullList(item.pullList);
  // Fields the reader was not sure of, still as it read them.
  const toCheck = item.kind === "card" ? fieldsToCheck(item) : [];
  const checkText = checkNotice(toCheck);
  const notes: [string, string][] = [];
  if (item.rarityNotes) notes.push(["About its rarity", item.rarityNotes]);
  if (item.conditionNotes) notes.push(["About its condition", item.conditionNotes]);
  if (item.worthGrading != null) {
    notes.push(["Worth grading?", `${item.worthGrading ? "Yes" : "No"}${item.gradingNotes ? `. ${item.gradingNotes}` : ""}`]);
  } else if (item.gradingNotes) {
    notes.push(["Grading", item.gradingNotes]);
  }
  if (item.aiNotes) notes.push(["Other notes from the reader", item.aiNotes]);

  return (
    <div className="flex flex-col gap-5">
      {photos.length > 0 ? (
        <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
          {photos.map((p) => (
            <li key={p.id} className="w-56 shrink-0 snap-start">
              <Link href={`/items/${item.id}/photo/${p.id}`} className="flex min-h-11 flex-col gap-1">
                {/* Plain img: photos come from our own /api/images route. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/images/${p.thumbFile}`} alt={`${ROLE_NAMES[p.role]} photo of ${item.title}`} className="aspect-[3/4] w-full rounded-xl bg-surface-2 object-contain" />
                <span className="text-sm text-muted">{ROLE_NAMES[p.role]} (tap to zoom, turn or trim)</span>
              </Link>
              {offerTrim(item, p) ? (
                <p className="text-xs text-muted">
                  The app did not cut this photo to the card.{" "}
                  <Link href={`/items/${item.id}/photo/${p.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
                    Trim the photo
                  </Link>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.kind === "card" && item.status === "needs_review" && holdReasons(item).includes("front_twice") ? (
        <Notice tone="warn">
          {FRONT_TWICE} {hasBack ? "Tap the Back photo above, then Replace this photo." : null}
        </Notice>
      ) : null}
      {!hasBack || !hasFront ? (
        <div className="flex flex-col gap-2">
          {!hasFront ? <PhotoUpload itemId={item.id} mode="add" role="front" title="Add a front photo" /> : null}
          {!hasBack ? <PhotoUpload itemId={item.id} mode="add" role="back" title="Add a back photo" /> : null}
        </div>
      ) : null}

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-balance break-words">{item.title}</h1>
        <ItemBadges item={item} />
        <p className="text-sm text-muted">
          {confidenceLabel(item.confidence)}
          {location ? ` · Stored in ${location.name}` : ""}
        </p>
        {setKey && item.year != null ? (
          <Link href={`/sets/${setKey}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">
            Set: {setLabel({ ...item, year: item.year })}. See the set
          </Link>
        ) : null}
      </header>

      <DuplicateNotice itemId={item.id} title={item.title} quantity={item.quantity} db={db} />

      {item.status === "needs_review" ? (
        <div className="flex flex-col gap-3">
          <Notice tone="warn">
            The reader was not sure about this one. Check the details, fix anything wrong, then confirm.
            {checkText ? <> {checkText}</> : null}
          </Notice>
          <form action={confirmItemAction}>
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" className="w-full">Looks right, confirm</Button>
          </form>
        </div>
      ) : null}

      <Card className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted">Value</h2>
        {waitingForVersion ? null : <p className="text-3xl font-bold">{formatCents(value)}</p>}
        {waitingForVersion ? <p className="text-sm font-semibold">{CHOOSE_VERSION_LINE}</p> : null}
        {value == null && !waitingForVersion ? <p className="text-sm">Use Find the value below.</p> : null}
        {value != null && !estimateHidden && !ownersValue && hasRange ? <p className="text-sm">Range: {formatCents(item.estLowCents)} to {formatCents(item.estHighCents)}</p> : null}
        {source && !waitingForVersion ? <p className="text-sm text-muted">Source: {valueSourceLabel(item.manualValueCents, item.valueSource)}</p> : null}
        {item.valueBasis && !estimateHidden && !ownersValue ? <p className="text-sm">{item.valueBasis}</p> : null}
        <p className="pt-1 text-xs text-muted">Estimates are a guide, not an appraisal.</p>
        {mode === "free" ? null : <ValueTools itemId={item.id} />}
      </Card>

      <GradingAdvice item={item} />
      <PriceLinks item={item} />

      {item.kind === "sealed" ? <Notice tone="accent">Keep it sealed. Sealed product is usually worth more unopened.</Notice> : null}

      {notes.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">What the reader noticed</h2>
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

      {item.kind === "card" ? <VersionPicker itemId={item.id} title={item.title} view={versionView(item)} /> : null}

      {item.kind === "card" ? <AskBlock item={item} catalogRookie={linkedFacts(item, db)?.rookie ?? false} /> : null}

      <CatalogBlock item={item} />

      <section id="edit" className="flex scroll-mt-4 flex-col gap-3">
        <h2 className="text-lg font-semibold">Edit details</h2>
        <ItemForm
          item={item} check={toCheck}
          locations={db.select({ id: locations.id, name: locations.name }).from(locations).orderBy(locations.name).all()}
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-5">
        <h2 className="text-lg font-semibold">Sold or given away?</h2>
        <OutcomeForms id={item.id} today={new Date().toISOString().slice(0, 10)} />
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-5">
        <h2 className="text-lg font-semibold">Remove</h2>
        <DeleteItemButton id={item.id} />
      </section>
    </div>
  );
}
