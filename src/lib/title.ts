import type { Item } from "@/db/schema";

type TitleFields = Partial<Pick<Item,
  "kind" | "year" | "yearEnd" | "brand" | "setName" | "cardNumber" | "player" | "variation" | "productType" | "sport" | "estCount" | "description"
>>;

const PRODUCT_LABELS: Record<string, string> = {
  pack: "pack", rack_pack: "rack pack", cello_pack: "cello pack", blister: "blister pack",
  box: "box", case: "case", factory_set: "factory set", other: "sealed product",
};

/** Builds the display name for an item, e.g. "1989 Upper Deck #1 Ken Griffey Jr." */
export function buildTitle(f: TitleFields): string {
  const years = f.year ? (f.yearEnd && f.yearEnd !== f.year ? `${f.year}-${f.yearEnd}` : `${f.year}`) : null;
  // Skip the set name when it only repeats the brand.
  const set = f.setName && f.setName.toLowerCase() !== (f.brand ?? "").toLowerCase() ? f.setName : null;
  const base = [years, f.brand, set].filter(Boolean).join(" ");
  let title: string;
  if (f.kind === "sealed") {
    const product = PRODUCT_LABELS[f.productType ?? "other"] ?? "sealed product";
    title = [base, f.sport && f.sport !== "other" ? f.sport : null, product].filter(Boolean).join(" ");
  } else if (f.kind === "bulk") {
    const count = f.estCount ? `about ${f.estCount.toLocaleString("en-US")} cards` : null;
    title = ["Bulk lot", base || f.description?.slice(0, 60) || null, count].filter(Boolean).join(", ");
  } else {
    title = [base, f.cardNumber ? `#${f.cardNumber}` : null, f.player, f.variation ? `(${f.variation})` : null]
      .filter(Boolean).join(" ");
  }
  return title.trim() || f.description?.trim().slice(0, 60) || "Unidentified item";
}
