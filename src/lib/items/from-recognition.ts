import type { NewItem, ValueSource } from "@/db/schema";
import { REVIEW_THRESHOLD, type RecognizedItem } from "@/lib/recognition/types";
import { buildTitle } from "@/lib/title";

/** The single figure used for totals: the middle of the estimated range. */
export function midpointCents(low: number | null, high: number | null): number | null {
  if (low != null && high != null) return Math.round((low + high) / 2);
  return low ?? high ?? null;
}

/** Turns one recognized item into a database row (not yet saved). */
export function itemFromRecognition(
  r: RecognizedItem,
  ctx: { scanId: number; locationId: number | null; valueSource: ValueSource; now: Date },
): NewItem {
  const low = r.estimate?.lowCents ?? null;
  const high = r.estimate?.highCents ?? null;
  const value = midpointCents(low, high);
  const isCard = r.kind === "card";
  return {
    kind: r.kind,
    status: r.confidence >= REVIEW_THRESHOLD ? "confirmed" : "needs_review",
    scanId: ctx.scanId,
    title: buildTitle(r),
    sport: r.sport,
    year: r.year,
    yearEnd: r.kind === "bulk" ? r.yearEnd : null,
    brand: r.brand,
    setName: r.setName,
    cardNumber: isCard ? r.cardNumber : null,
    player: isCard ? r.player : null,
    team: isCard ? r.team : null,
    variation: r.variation,
    isRookie: isCard && r.isRookie,
    isError: isCard && r.isError,
    isParallel: isCard && r.isParallel,
    isInsert: isCard && r.isInsert,
    isAutograph: isCard && r.isAutograph,
    isMemorabilia: isCard && r.isMemorabilia,
    serialNumber: isCard ? r.serialNumber : null,
    rarityTier: r.rarityTier,
    rarityNotes: r.rarityNotes,
    condition: isCard ? r.condition : null,
    conditionNotes: r.conditionNotes,
    grader: isCard ? r.grader : null,
    grade: isCard ? r.grade : null,
    certNumber: isCard ? r.certNumber : null,
    worthGrading: isCard ? r.worthGrading : null,
    gradingNotes: isCard ? r.gradingNotes : null,
    productType: r.kind === "sealed" ? (r.productType ?? "other") : null,
    packCount: r.kind === "sealed" ? r.packCount : null,
    sealState: r.kind === "sealed" ? (r.sealState ?? "unknown") : null,
    estCount: r.kind === "bulk" ? r.estCount : null,
    containerType: r.kind === "bulk" ? r.containerType : null,
    description: r.description,
    pullList: r.pullList.length ? JSON.stringify(r.pullList) : null,
    quantity: 1,
    locationId: ctx.locationId,
    confidence: r.confidence,
    aiNotes: r.notes,
    estLowCents: low,
    estHighCents: high,
    estValueCents: value,
    valueSource: value != null ? ctx.valueSource : null,
    valueBasis: r.estimate?.basis ?? null,
    valuedAt: value != null ? ctx.now : null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** Reads the stored pull list back into an array. Bad data gives an empty list. */
export function parsePullList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
