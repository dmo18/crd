import type { CatalogField, Item } from "@/db/schema";
import { HOLD_REASONS, type HoldReason } from "@/lib/recognition/types";
import { fieldsToCheck, isFilled, parseFirstSuggestion } from "@/lib/catalog/sources";
import { CARD_FIELD_LABELS } from "./labels";
import type { DuplicateMatch } from "./duplicates";

/**
 * The three groups of the Review screen (Milestone 13):
 * - ready: player, year, brand and number all filled, nothing contradicting,
 *   not held back (reprint, lone side, error version and the other holds) and
 *   no possible duplicate. "Check this" marks may be there: confirming says
 *   the values are right as read.
 * - look: something blank, held back, a possible duplicate, or a
 *   contradiction. Also sealed products and lots, always checked one by one.
 * - unread: neither the player nor the card number was read.
 */
export const REVIEW_GROUPS = ["ready", "look", "unread"] as const;
export type ReviewGroupId = (typeof REVIEW_GROUPS)[number];

export const REVIEW_GROUP_TITLES: Record<ReviewGroupId, { title: string; help: string }> = {
  ready: { title: "Ready to confirm", help: "Player, year, brand and number are all filled and nothing contradicts them." },
  look: { title: "Needs a look", help: "Something is blank, held back or may be a card you already have." },
  unread: { title: "Could not read", help: "Neither the player nor the card number was read. Open each one to fill it in, or delete it." },
};

/** The four fields a card needs to be ready. */
export const READY_FIELDS = ["player", "year", "brand", "cardNumber"] as const satisfies readonly CatalogField[];

/** Short words for each hold reason, for a Review row. The item page has the long words. */
export const HOLD_SHORT: Record<HoldReason, string> = {
  reprint: "Marked REPRINT, so not the original card",
  one_side: "Only one side of this card was matched",
  hard_to_read: "The text was hard to read",
  error_check: "May be a known error version",
  key_list_guess: "Only a possible key card",
};

export type ReviewGrouping = {
  group: ReviewGroupId;
  /** Why it is not ready, in a few plain words each. Empty for a ready card. */
  reasons: string[];
  /** Fields marked "Check this" (as their labels). */
  check: string[];
};

export type GroupingFacts = {
  /** The first possible duplicate, as Review shows it. */
  duplicate: DuplicateMatch | null;
  /** Labels of fields where a linked catalog card says something else. */
  catalogDifferences: readonly string[];
};

function holds(item: Pick<Item, "firstSuggestion">): HoldReason[] {
  const list = parseFirstSuggestion(item.firstSuggestion)?.hold ?? [];
  return HOLD_REASONS.filter((h) => list.includes(h));
}

/** The group of one item waiting in Review, and why. */
export function reviewGroupOf(item: Item, facts: GroupingFacts): ReviewGrouping {
  const check = item.kind === "card" ? fieldsToCheck(item).map((f) => CARD_FIELD_LABELS[f]) : [];
  if (item.kind !== "card") return { group: "look", reasons: ["Sealed products and lots are checked one by one"], check };
  if (!isFilled(item.player) && !isFilled(item.cardNumber)) {
    return { group: "unread", reasons: ["The player and the card number were not read"], check };
  }
  const reasons: string[] = [];
  const blank = READY_FIELDS.filter((f) => !isFilled(item[f]));
  if (blank.length > 0) reasons.push(`Blank: ${blank.map((f) => CARD_FIELD_LABELS[f]).join(", ")}`);
  for (const h of holds(item)) reasons.push(HOLD_SHORT[h]);
  if (facts.duplicate) {
    reasons.push(facts.duplicate.item.status === "needs_review"
      ? `May be the same card as one also in Review: ${facts.duplicate.item.title}`
      : `May be a card you already have: ${facts.duplicate.item.title}`);
  }
  if (facts.catalogDifferences.length > 0) reasons.push(`The catalog says something else for: ${facts.catalogDifferences.join(", ")}`);
  if (item.rookieState === "disputed") reasons.push("The rookie mark is in doubt");
  return { group: reasons.length === 0 ? "ready" : "look", reasons, check };
}
