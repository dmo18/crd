import { CopyText } from "@/components/items/CopyText";
import { GuideRefresh } from "@/components/items/GuideRefresh";
import { QuickValue } from "@/components/items/QuickValue";
import { Card } from "@/components/ui";
import type { Item } from "@/db/schema";
import { POPULATION_NOTE, priceLinks, type PriceLink } from "@/lib/links";
import { formatCents } from "@/lib/money";
import { guidePrice } from "@/lib/valuation/guide";

const LINK_CLASS =
  "flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-center text-base font-semibold text-text";

function LinkList({ links }: { links: PriceLink[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {links.map((link) => (
        <li key={link.label}>
          <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {link.label}{link.paste === "words" ? " (paste the words)" : link.paste === "cert" ? " (paste the number)" : ""}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Find the value" on the item page: the guide price status, "Check real
 * sales" links built only from the item's fields (the server never calls
 * these sites), and a box to save the price the owner saw.
 */
export function PriceLinks({ item }: { item: Item }) {
  const links = priceLinks(item);
  // The guide's missing line does not depend on stored facts, so the pure function is enough here.
  const guide = guidePrice(item);
  const guideBehindOwnValue = item.manualValueCents != null && item.valueSource === "price_guide" && item.estLowCents != null;
  const needsWords = links.sales.some((l) => l.paste === "words") || links.population.some((l) => l.paste === "words");
  const needsCert = links.cert.some((l) => l.paste === "cert") && item.certNumber;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Find the value</h2>
      {!guide.ok ? <p className="text-sm">{guide.missing}</p> : null}
      {guideBehindOwnValue ? (
        <p className="text-sm text-muted">
          Price guide (rough): {formatCents(item.estLowCents)} to {formatCents(item.estHighCents)}. Your own value is used.
        </p>
      ) : null}
      {item.manualValueCents == null ? <GuideRefresh itemId={item.id} /> : null}

      {links.sales.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Check real sales">
          <h3 className="font-semibold">Check real sales</h3>
          <p className="text-sm text-muted">These open other websites. Look for recent sold prices of the same card in similar condition.</p>
          <LinkList links={links.sales} />
          {needsWords ? <CopyText text={links.query} label="Copy search words" /> : null}
        </section>
      ) : null}

      {links.cert.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Certificate">
          <h3 className="font-semibold">Check the certificate</h3>
          <LinkList links={links.cert} />
          {needsCert ? <CopyText text={item.certNumber!.trim()} label="Copy certificate number" /> : null}
        </section>
      ) : null}

      {links.population.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Graded copies">
          <h3 className="font-semibold">How many graded copies</h3>
          <LinkList links={links.population} />
          <p className="text-sm text-muted">{POPULATION_NOTE}.</p>
        </section>
      ) : null}

      {links.sales.length > 0 ? (
        <QuickValue itemId={item.id} label="I checked: it sells for about" />
      ) : (
        <QuickValue itemId={item.id} help="Enter what you think the whole lot is worth." />
      )}
    </Card>
  );
}
