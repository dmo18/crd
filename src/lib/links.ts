import type { Item } from "@/db/schema";

type LinkFields = Pick<Item,
  "kind" | "year" | "brand" | "setName" | "player" | "cardNumber" | "variation" | "grader" | "grade" | "certNumber" | "sport" | "productType"
>;

export type SoldLink = { label: string; href: string };

const PRODUCT_WORDS: Record<string, string> = {
  pack: "wax pack", rack_pack: "rack pack", cello_pack: "cello pack", blister: "blister pack",
  box: "wax box", case: "case", factory_set: "factory set", other: "",
};

/** The words to search for on a sold-listings site. Empty when there is nothing useful to search. */
export function buildSearchQuery(item: LinkFields): string {
  let parts: (string | number | null | undefined)[];
  if (item.kind === "card") {
    if (!item.player && !item.cardNumber) return "";
    const set = item.setName && item.setName.toLowerCase() !== (item.brand ?? "").toLowerCase() ? item.setName : null;
    const graded = item.grader && item.grade ? `${item.grader} ${item.grade}` : null;
    parts = [item.year, item.brand, set, item.player, item.cardNumber ? `#${item.cardNumber}` : null, item.variation, graded];
  } else if (item.kind === "sealed") {
    if (!item.year && !item.brand) return "";
    const set = item.setName && item.setName.toLowerCase() !== (item.brand ?? "").toLowerCase() ? item.setName : null;
    const sport = item.sport && item.sport !== "other" && item.sport !== "multi" ? item.sport : null;
    parts = [item.year, item.brand, set, sport, PRODUCT_WORDS[item.productType ?? "other"], "sealed"];
  } else {
    return "";
  }
  return parts.filter((p) => p != null && p !== "").join(" ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
}

/** Links to other websites where real sold prices can be checked. */
export function soldListingLinks(item: LinkFields): SoldLink[] {
  const query = buildSearchQuery(item);
  const links: SoldLink[] = [];
  if (query) {
    const ebay = new URL("https://www.ebay.com/sch/i.html");
    ebay.search = new URLSearchParams({ _nkw: query, LH_Sold: "1", LH_Complete: "1" }).toString();
    links.push({ label: "eBay sold listings", href: ebay.toString() });
    const point = new URL("https://130point.com/sales/");
    point.search = new URLSearchParams({ search: query }).toString();
    links.push({ label: "130point sold search", href: point.toString() });
  }
  const cert = item.certNumber?.trim() ?? "";
  if (item.kind === "card" && item.grader?.trim().toUpperCase() === "PSA" && /^\d{5,12}$/.test(cert)) {
    links.push({ label: "PSA cert lookup", href: `https://www.psacard.com/cert/${cert}` });
  }
  return links;
}
