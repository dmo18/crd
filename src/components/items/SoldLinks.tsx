import type { Item } from "@/db/schema";
import { soldListingLinks } from "@/lib/links";

/** Links out to real sold prices for this item. Shows nothing when there is nothing to search for. */
export function SoldLinks({ item }: { item: Item }) {
  const links = soldListingLinks(item);
  if (links.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Check real sold prices</h2>
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-base font-semibold text-text"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">These open other websites. Sold prices are the best guide to what a card is really worth.</p>
    </section>
  );
}
