import { createHash } from "node:crypto";
import { CONDITIONS, type Condition, type Item } from "@/db/schema";
import { midpointCents } from "@/lib/items/from-recognition";
import { adjustForCondition } from "./condition";
import type { PriceQuote, PriceSource } from "./types";

/**
 * A free, offline price source for previews, tests and using the app without
 * an AI key. It does not look anything up. It starts from the item's current
 * estimate and moves it to the item's current condition, so changing the
 * condition and asking again gives a visibly different number. The same item
 * always gives the same answer.
 */

export const SAMPLE_BASIS = "Sample data, not a real estimate.";

const conditionWords = (c: Condition) => c.replace("_", " ");

/**
 * The condition an earlier sample estimate was priced for, read back from its
 * basis sentence ("... in near mint condition."). The sample recognizer writes
 * the same wording.
 */
export function pricedForCondition(basis: string | null): Condition | null {
  if (!basis || !basis.startsWith(SAMPLE_BASIS)) return null;
  const match = / in ([a-z ]+) condition\.$/.exec(basis);
  if (!match) return null;
  const found = CONDITIONS.find((c) => conditionWords(c) === match[1]);
  return found ?? null;
}

/** A stable made-up near mint range for an item that has no estimate yet. */
function madeUpRange(item: Item): { low: number; high: number } {
  const key = [item.kind, item.year, item.brand, item.setName, item.cardNumber, item.player, item.productType]
    .map((v) => String(v ?? ""))
    .join("|");
  const n = createHash("sha256").update(key).digest().readUInt32BE(0);
  const [min, max] = item.kind === "sealed" ? [500, 5000] : item.kind === "bulk" ? [200, 2000] : [5, 500];
  const low = min + (n % (max - min));
  return { low, high: low * 3 };
}

function move(cents: number | null, from: Condition, to: Condition): number | null {
  if (cents == null) return null;
  const moved = adjustForCondition(cents, from, to);
  return cents > 0 ? Math.max(1, moved) : moved;
}

export class SampleSource implements PriceSource {
  readonly name = "sample";

  async quote(item: Item): Promise<PriceQuote | null> {
    const to: Condition | null = item.condition;
    const hasEstimate = item.estLowCents != null || item.estHighCents != null || item.estValueCents != null;

    let low: number | null;
    let high: number | null;
    let from: Condition | null;
    if (hasEstimate) {
      low = item.estLowCents ?? item.estValueCents;
      high = item.estHighCents ?? item.estValueCents;
      // Earlier sample estimates say which condition they were priced for.
      // Anything else is taken to match the condition the item has now.
      from = (item.valueSource === "sample" ? pricedForCondition(item.valueBasis) : null) ?? to;
    } else {
      const range = madeUpRange(item);
      low = range.low;
      high = range.high;
      from = "near_mint";
    }

    if (to && from) {
      low = move(low, from, to);
      high = move(high, from, to);
    }
    const value = midpointCents(low, high);
    if (value == null) return null;
    return {
      lowCents: low,
      highCents: high,
      valueCents: value,
      basis: to ? `${SAMPLE_BASIS} Rough raw value for this card in ${conditionWords(to)} condition.` : SAMPLE_BASIS,
      source: "sample",
    };
  }
}
