import type { Item } from "@/db/schema";
import { effectiveValueCents } from "@/lib/money";

/** Shown in place of the estimate while the version is "Not sure yet" (PLAN Milestone 11, "Value"). */
export const CHOOSE_VERSION_LINE = "Choose the version to see a value";

type ValueFacts = Pick<Item, "manualValueCents" | "estValueCents" | "versionState">;

/**
 * The value to show for one unit. While the version is "Not sure yet" the
 * estimate is hidden (the exact version decides the price), but the owner's
 * own figure is always shown. A card never asked (null state) shows its value
 * as before. Stored values and totals are not touched.
 */
export function shownValue(item: ValueFacts): { cents: number | null; waitingForVersion: boolean } {
  const waitingForVersion = item.versionState === "not_sure" && item.manualValueCents == null;
  return { cents: waitingForVersion ? null : effectiveValueCents(item), waitingForVersion };
}
