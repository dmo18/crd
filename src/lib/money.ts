/** Formats whole cents as US dollars, e.g. 123456 becomes "$1,234.56". */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "No value yet";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** The value to use for one unit of an item: the owner's figure wins. */
export function effectiveValueCents(item: { manualValueCents: number | null; estValueCents: number | null }): number | null {
  return item.manualValueCents ?? item.estValueCents ?? null;
}

/** Parses what a person typed ("$1,234.50", "12") into cents, or null. */
export function parseDollars(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}
