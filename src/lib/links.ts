import type { Item } from "@/db/schema";
import { splitSerial } from "@/lib/items/serial";

/**
 * Links to other websites where the owner can check real prices, built only
 * from the item's own fields. The server never calls these sites (they block
 * automated visits); the owner taps them on the phone.
 */

type LinkFields = Pick<Item,
  "kind" | "year" | "brand" | "setName" | "player" | "cardNumber" | "variation" | "grader" | "grade" | "certNumber" | "sport" | "productType"
> & Partial<Pick<Item, "isRookie" | "isAutograph" | "serialNumber" | "serialEdition">>;

export type PriceLink = {
  label: string;
  href: string;
  /** The site does not take words in its address: "words" means paste the search words, "cert" the certificate number. */
  paste?: "words" | "cert";
};

export type PriceLinks = {
  /** The search words, also offered by "Copy the card name". Empty when there is nothing to search. */
  query: string;
  sales: PriceLink[];
  /** Certificate lookups for a graded card. */
  cert: PriceLink[];
  /** Population report pages for a graded card. */
  population: PriceLink[];
};

/** Shown beside the population links, word for word. */
export const POPULATION_NOTE = "This counts graded copies, not how many were printed";

/**
 * eBay's "Sports Mem, Cards & Fan Shop" category. One broad category for
 * every sport on purpose: the per-sport ids could not be checked from here
 * (eBay blocks automated visits), and a wrong id would hide every result.
 */
export const EBAY_CATEGORY = "64482";

const PRODUCT_WORDS: Record<string, string> = {
  pack: "wax pack", rack_pack: "rack pack", cello_pack: "cello pack", blister: "blister pack",
  box: "wax box", case: "case", factory_set: "factory set", other: "",
};

/** Accents stripped ("José" becomes "Jose"), quotes and control characters dropped. */
function plain(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/["\u0000-\u001f\u007f\u201c\u201d]/g, " ");
}

function edition(item: LinkFields): string | null {
  const e = item.serialEdition ?? splitSerial(item.serialNumber)?.edition ?? null;
  return e && /^\d{1,6}$/.test(e) ? e : null;
}

/** The words to search for on a price site. Empty when there is nothing useful to search. */
export function buildSearchQuery(item: LinkFields): string {
  let parts: (string | number | null | undefined)[];
  const set = item.setName && item.setName.toLowerCase() !== (item.brand ?? "").toLowerCase() ? item.setName : null;
  if (item.kind === "card") {
    if (!item.player && !item.cardNumber) return "";
    const graded = item.grader && item.grade ? `${item.grader} ${item.grade}` : null;
    const run = edition(item);
    parts = [
      item.year, item.brand, set, item.player, item.cardNumber ? `#${item.cardNumber.replace(/^#+/, "")}` : null, item.variation,
      item.isRookie ? "RC" : null, run ? `/${run}` : null, item.isAutograph ? "auto" : null, graded,
    ];
  } else if (item.kind === "sealed") {
    if (!item.year && !item.brand) return "";
    const sport = item.sport && item.sport !== "other" && item.sport !== "multi" ? item.sport : null;
    parts = [item.year, item.brand, set, sport, PRODUCT_WORDS[item.productType ?? "other"], "sealed"];
  } else {
    return "";
  }
  const text = parts.filter((p) => p != null && p !== "").map((p) => plain(String(p))).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 120).trim();
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

/** The cert number when it is plain digits, else null (never put other text in an address). */
function cleanCert(item: LinkFields): string | null {
  const cert = item.certNumber?.trim() ?? "";
  return /^\d{5,12}$/.test(cert) ? cert : null;
}

const GRADERS = {
  PSA: {
    cert: (n: string): PriceLink => ({ label: "PSA certificate", href: `https://www.psacard.com/cert/${n}` }),
    pop: { label: "PSA population report", href: "https://www.psacard.com/pop", paste: "words" },
  },
  SGC: {
    cert: (): PriceLink => ({ label: "SGC certificate lookup", href: "https://gosgc.com/cert-code-lookup", paste: "cert" }),
    pop: { label: "SGC population report", href: "https://gosgc.com/pop-report", paste: "words" },
  },
  BGS: {
    cert: (): PriceLink => ({ label: "Beckett certificate lookup", href: "https://www.beckett.com/grading/card-lookup", paste: "cert" }),
    pop: { label: "Beckett population report", href: "https://www.beckett.com/grading/pop-report", paste: "words" },
  },
  CGC: {
    cert: (n: string): PriceLink => ({ label: "CGC certificate", href: `https://www.cgccards.com/certlookup/${n}/` }),
    pop: { label: "CGC population report", href: "https://www.cgccards.com/population-report/", paste: "words" },
  },
} as const;
type Grader = keyof typeof GRADERS;

function graderOf(item: LinkFields): Grader | null {
  const g = item.grader?.trim().toUpperCase() ?? "";
  if (g === "BVG" || g === "BECKETT") return "BGS";
  return g in GRADERS ? (g as Grader) : null;
}

/** The words on a link's button: a site that takes no words says what to paste. */
export function linkLabel(link: PriceLink): string {
  return `${link.label}${link.paste === "words" ? " (paste the card name)" : link.paste === "cert" ? " (paste the number)" : ""}`;
}

/** Every "Check real sales" link for an item. Each opens another website. */
export function priceLinks(item: LinkFields): PriceLinks {
  const query = buildSearchQuery(item);
  const sales: PriceLink[] = [];
  if (query) {
    const ebay = "https://www.ebay.com/sch/i.html";
    sales.push({ label: "eBay sold listings", href: withQuery(ebay, { _nkw: query, _sacat: EBAY_CATEGORY, LH_Sold: "1", LH_Complete: "1" }) });
    sales.push({ label: "eBay for sale now", href: withQuery(ebay, { _nkw: query, _sacat: EBAY_CATEGORY }) });
    // 130point has no search address that takes words: the link says to paste the card name (copied below it).
    sales.push({ label: "130point", href: "https://130point.com/sales/", paste: "words" });
    if (item.kind === "card") {
      sales.push({ label: "TCDB card search", href: withQuery("https://www.tcdb.com/Search.cfm", { q: query }) });
      sales.push({ label: "COMC search", href: `https://www.comc.com/Cards,=${encodeURIComponent(query)}` });
      sales.push({ label: "SportsCardsPro prices", href: withQuery("https://www.sportscardspro.com/search-products", { q: query, type: "prices" }) });
    }
    sales.push({ label: "Google search", href: withQuery("https://www.google.com/search", { q: `${query} sold` }) });
  }
  const cert: PriceLink[] = [];
  const population: PriceLink[] = [];
  if (item.kind === "card" && item.grader?.trim()) {
    const grader = graderOf(item);
    const n = cleanCert(item);
    if (grader && n) cert.push(GRADERS[grader].cert(n));
    if (grader) population.push(GRADERS[grader].pop);
    else for (const g of Object.values(GRADERS)) population.push(g.pop);
  }
  return { query, sales, cert, population };
}
