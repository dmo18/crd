import { CONDITIONS, type Item } from "@/db/schema";
import { effectiveValueCents } from "@/lib/money";

export type GradingAdvice = { tone: "neutral" | "gold"; text: string };

type GradingFields = Pick<Item, "kind" | "grader" | "grade" | "condition" | "worthGrading" | "manualValueCents" | "estValueCents" | "estHighCents" | "valueSource">;

/** Below this value per card, grading costs more than it can add. */
export const GRADING_FLOOR_CENTS = 2000;

const rank = (c: Item["condition"]) => (c ? CONDITIONS.indexOf(c) : -1);
const NEAR_MINT = CONDITIONS.indexOf("near_mint");

/** A real basis: a ranged estimate from the app or a price guide whose top end is still under the floor, and no owner figure above it. */
function lowByEstimate(item: GradingFields): boolean {
  if (item.valueSource !== "ai_estimate" && item.valueSource !== "price_feed") return false;
  if (item.estHighCents == null || item.estHighCents >= GRADING_FLOOR_CENTS) return false;
  return item.manualValueCents == null || item.manualValueCents < GRADING_FLOOR_CENTS;
}

/**
 * Short, honest advice on grading a raw card, from saved data only.
 * Returns null for anything that is not a raw card or when there is nothing useful to say.
 */
export function gradingAdvice(item: GradingFields): GradingAdvice | null {
  if (item.kind !== "card") return null;
  if (item.grader?.trim() || item.grade?.trim()) return null;
  const value = effectiveValueCents(item);
  if (value == null) return null;
  if (value < GRADING_FLOOR_CENTS) {
    // One typed price, or a sample figure, is not a sound basis for telling the owner not to grade.
    if (!lowByEstimate(item)) return null;
    return { tone: "neutral", text: "Not worth grading. Grading usually costs more than this card is worth." };
  }
  const condition = rank(item.condition);
  if (item.worthGrading === true && condition >= NEAR_MINT) {
    return {
      tone: "gold",
      text: "Could be worth grading. In top grade this card can sell for much more than a raw copy. Check sold prices for graded copies first.",
    };
  }
  if (condition >= 0 && condition < NEAR_MINT) {
    return { tone: "neutral", text: "Probably not worth grading in this condition." };
  }
  return null;
}
