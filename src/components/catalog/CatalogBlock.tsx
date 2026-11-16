import { eq } from "drizzle-orm";
import { Badge, Card, LinkButton } from "@/components/ui";
import { getDb } from "@/db";
import { catalogCards, catalogSources, type Item } from "@/db/schema";
import { cardLine } from "@/lib/catalog/line";
import { sourceUrl } from "@/lib/catalog/clean";
import { parseFirstSuggestion } from "@/lib/catalog/sources";
import { unlinkCatalogAction, catalogValuesOnItemAction } from "@/lib/catalog/item-actions";
import { applyCatalogCard } from "@/lib/catalog/apply";
import { FIELD_WORDS } from "@/lib/catalog/pick";
import { Button } from "@/components/ui";
import { SPORT_LABELS } from "@/lib/items/labels";

const FIRST_LABELS = [
  ["sport", "Sport"], ["year", "Year"], ["brand", "Brand"], ["setName", "Set"], ["cardNumber", "Number"],
  ["player", "Player"], ["team", "Team"], ["variation", "Variation"],
] as const;

/** The "Catalog card" block of an item page, and "What the scanner first read" under it. */
export function CatalogBlock({ item }: { item: Item }) {
  const db = getDb();
  const card = item.catalogCardId == null ? null : db.select().from(catalogCards).where(eq(catalogCards.id, item.catalogCardId)).get() ?? null;
  const src = card ? db.select().from(catalogSources).where(eq(catalogSources.catalogCardId, card.id)).get() : null;
  const href = sourceUrl(src?.url);
  const first = parseFirstSuggestion(item.firstSuggestion);
  // Fields the scanner read differently from the linked card ("This is my card" keeps them until the owner chooses).
  const differences = card ? applyCatalogCard(item, card).differences : [];
  const search = new URLSearchParams({ itemId: String(item.id) });
  return (
    <section className="flex flex-col gap-3" aria-labelledby="catalog-heading">
      <Card className="flex flex-col gap-3">
        <h2 id="catalog-heading" className="text-lg font-semibold">Catalog card</h2>
        {card ? (
          <>
            <p className="font-semibold break-words">{cardLine(card)}</p>
            {card.verified ? null : <div><Badge tone="warn">Unverified listing</Badge></div>}
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
                From MyCardfolio (opens in a new tab)
              </a>
            ) : null}
            {differences.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-3">
                <p className="text-sm font-semibold">Some details differ from the catalog:</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {differences.map((d) => (
                    <li key={d.field} className="break-words">Scanner read {FIELD_WORDS[d.field]}: {d.itemValue == null ? "" : String(d.itemValue)}. Catalog says: {d.catalogValue == null ? "" : String(d.catalogValue)}</li>
                  ))}
                </ul>
                <form action={catalogValuesOnItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <Button type="submit" className="w-full">Use the catalog&apos;s values</Button>
                </form>
                <p className="text-xs text-muted">Details you typed yourself are never changed.</p>
              </div>
            ) : null}
            <form action={unlinkCatalogAction}>
              <input type="hidden" name="id" value={item.id} />
              <Button type="submit" variant="secondary" className="w-full">Unlink</Button>
            </form>
            <p className="text-xs text-muted">Unlinking keeps every detail on this item as it is.</p>
          </>
        ) : item.kind === "card" ? (
          <>
            <p className="text-sm text-muted">This card is not tied to a catalog card yet. Linking fills in empty details and never changes what you typed.</p>
            <LinkButton href={`/search?${search.toString()}`} variant="secondary" className="w-full">Find this card in the catalog</LinkButton>
          </>
        ) : (
          <p className="text-sm text-muted">Only single cards can be linked to a catalog card.</p>
        )}
      </Card>
      {first ? (
        <details className="rounded-2xl border border-border bg-surface px-4">
          <summary className="min-h-11 cursor-pointer py-3 text-base font-semibold">What the scanner first read</summary>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pb-3 text-sm">
            {FIRST_LABELS.map(([k, label]) => {
              const v = first.fields[k];
              if (v == null || v === "") return null;
              return (
                <div key={k} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-words">{k === "sport" ? SPORT_LABELS[v as keyof typeof SPORT_LABELS] ?? String(v) : String(v)}</dd>
                </div>
              );
            })}
            {first.confidence != null ? (
              <div className="contents"><dt className="text-muted">Sure about it</dt><dd>{Math.round(first.confidence * 100)}%</dd></div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
