import type { Item, ValueSource } from "@/db/schema";

/**
 * The contract for anything that can put a price on an item.
 *
 * Two sources exist today: a free sample one and the AI estimate. A paid price
 * feed can be added later as one more PriceSource (with source "price_feed")
 * and picked in `getPriceSource()`; callers such as `revalueItem` do not change.
 */

/** A price for ONE unit of an item, in whole US cents. */
export type PriceQuote = {
  lowCents: number | null;
  highCents: number | null;
  /** The single figure used for totals, usually the middle of the range. */
  valueCents: number;
  /** One plain sentence on what the figure is based on. */
  basis: string | null;
  source: ValueSource;
};

export interface PriceSource {
  /** Short name, e.g. "sample" or the AI model name. */
  readonly name: string;
  /** Returns null when the source cannot put a value on this item. */
  quote(item: Item): Promise<PriceQuote | null>;
}

/** Thrown with a message that is safe to show to the owner. */
export class ValuationError extends Error {
  constructor(public readonly userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = "ValuationError";
  }
}
