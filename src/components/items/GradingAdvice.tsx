import { Notice } from "@/components/ui";
import type { Item } from "@/db/schema";
import { gradingAdvice } from "@/lib/valuation/grading";

/** One line of plain advice on whether a raw card is worth sending for grading. */
export function GradingAdvice({ item }: { item: Item }) {
  const advice = gradingAdvice(item);
  if (!advice) return null;
  return <Notice tone={advice.tone}>{advice.text}</Notice>;
}
