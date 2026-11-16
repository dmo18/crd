import type { CatalogField, Condition, ItemKind, ProductType, RarityTier, SealState, Sport } from "@/db/schema";

export const KIND_LABELS: Record<ItemKind, string> = {
  card: "Card",
  sealed: "Sealed product",
  bulk: "Bulk lot",
};

export const SPORT_LABELS: Record<Sport, string> = {
  baseball: "Baseball",
  basketball: "Basketball",
  football: "Football",
  hockey: "Hockey",
  soccer: "Soccer",
  golf: "Golf",
  racing: "Racing",
  wrestling: "Wrestling",
  boxing: "Boxing",
  multi: "More than one sport",
  other: "Other",
};

export const CONDITION_LABELS: Record<Condition, string> = {
  poor: "Poor",
  fair: "Fair",
  good: "Good",
  very_good: "Very good",
  excellent: "Excellent",
  near_mint: "Near mint",
  mint: "Mint",
  gem_mint: "Gem mint",
};

export const RARITY_LABELS: Record<RarityTier, string> = {
  common: "Common",
  minor_star: "Minor star",
  star: "Star",
  key: "Key card",
  grail: "Grail",
};

export const PRODUCT_LABELS: Record<ProductType, string> = {
  pack: "Pack",
  rack_pack: "Rack pack",
  cello_pack: "Cello pack",
  blister: "Blister pack",
  box: "Box",
  case: "Case",
  factory_set: "Factory set",
  other: "Other",
};

export const SEAL_LABELS: Record<SealState, string> = {
  factory_sealed: "Factory sealed",
  possibly_resealed: "May have been resealed",
  opened: "Opened",
  unknown: "Not sure",
};

export const VALUE_SOURCE_LABELS = {
  ai_estimate: "AI estimate",
  sample: "Sample data",
  manual: "Your value",
  price_feed: "Price guide",
} as const;

/** e.g. 0.93 becomes "93% sure". */
export function confidenceLabel(c: number | null): string {
  if (c == null || Number.isNaN(c)) return "Not rated";
  return `${Math.round(Math.min(Math.max(c, 0), 1) * 100)}% sure`;
}

/** Names of the card fields a reading fills, as the item form shows them. */
export const CARD_FIELD_LABELS: Record<CatalogField, string> = {
  sport: "Sport",
  year: "Year",
  brand: "Brand",
  setName: "Set",
  cardNumber: "Card number",
  player: "Player",
  team: "Team",
  variation: "Variation",
};

/** One line for Review: which fields the reader was not sure of. */
export function checkLine(fields: readonly CatalogField[]): string | null {
  if (fields.length === 0) return null;
  return `Not sure of: ${fields.map((f) => CARD_FIELD_LABELS[f]).join(", ")}. Check ${fields.length === 1 ? "it" : "them"} against the card.`;
}
