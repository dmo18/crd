import type { Condition } from "@/db/schema";

/**
 * Rough price of a raw card in each condition, relative to near mint.
 * A guide only: real prices for top cards swing much more between grades.
 */
export const CONDITION_MULTIPLIERS: Readonly<Record<Condition, number>> = {
  poor: 0.08,
  fair: 0.12,
  good: 0.2,
  very_good: 0.3,
  excellent: 0.5,
  near_mint: 1,
  mint: 1.6,
  gem_mint: 2.5,
};

/** Moves a price in cents from one condition to another. Whole cents, never negative. */
export function adjustForCondition(cents: number, from: Condition, to: Condition): number {
  if (from === to) return Math.max(0, Math.round(cents));
  const value = (cents * CONDITION_MULTIPLIERS[to]) / CONDITION_MULTIPLIERS[from];
  return Math.max(0, Math.round(value));
}
