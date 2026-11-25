import type { CatalogField, NewItem, ValueSource } from "@/db/schema";
import { CERTAIN_FIELDS, REVIEW_THRESHOLD, type RecognizedItem } from "@/lib/recognition/types";
import { serializeCatalog } from "@/lib/catalog/candidates";
import { buildFirstSuggestion, sourcesFor, type FieldSources } from "@/lib/catalog/sources";
import { buildTitle } from "@/lib/title";
import { rookieFromScan } from "./rookie";
import { suggestionFromRead } from "./serial";

/** The single figure used for totals: the middle of the estimated range. */
export function midpointCents(low: number | null, high: number | null): number | null {
  if (low != null && high != null) return Math.round((low + high) / 2);
  return low ?? high ?? null;
}

/**
 * Turns one recognized item into a database row (not yet saved). The fields
 * the reader filled are marked `reading`, and what it read is kept once in
 * `firstSuggestion`, which no later change touches. Catalog candidates, or
 * why the catalog was not checked, are kept for Review. Catalog cards are
 * never applied here; automatic filling is OFF (AUTO_FILL_SURE), so every
 * catalog card needs the owner's tap in Review.
 */
export function itemFromRecognition(
  r: RecognizedItem,
  ctx: { scanId: number; locationId: number | null; valueSource: ValueSource; now: Date; recognizer?: string | null },
): NewItem {
  const low = r.estimate?.lowCents ?? null;
  const high = r.estimate?.highCents ?? null;
  const value = midpointCents(low, high);
  const isCard = r.kind === "card";
  const read = {
    sport: r.sport,
    year: r.year,
    brand: r.brand,
    setName: r.setName,
    cardNumber: isCard ? r.cardNumber : null,
    player: isCard ? r.player : null,
    team: isCard ? r.team : null,
    variation: r.variation,
  };
  // Blanks the catalog's set list filled (rule D) are the catalog's values, not the card's:
  // marked `checklist` and never kept in firstSuggestion as read from the card.
  const fromList = new Set<CatalogField>(isCard ? (r.evidence?.checklist ?? []) : []);
  const cardRead: typeof read = { ...read };
  for (const f of fromList) cardRead[f] = null;
  const marks = JSON.parse(sourcesFor(read, "reading")) as FieldSources;
  for (const f of fromList) if (marks[f]) marks[f] = "checklist";
  const serial = isCard ? (r.evidence?.serial ?? (r.serialNumber ? { text: r.serialNumber } : null)) : null;
  const suggestion = suggestionFromRead(serial, r.year);
  const serialSuggestion = suggestion ? JSON.stringify(suggestion) : null;
  const cat = isCard ? r.catalog : undefined;
  let catalogCandidates: string | null = null;
  // A verified match is stored as the first candidate; the scan then links it (src/lib/scans/process.ts).
  if (cat?.status === "candidates" || cat?.status === "matched") catalogCandidates = serializeCatalog({ status: "candidates", items: cat.candidates }, ctx.now);
  else if (cat?.status === "none") catalogCandidates = serializeCatalog({ status: "none" }, ctx.now);
  else if (cat?.status === "not_checked") catalogCandidates = serializeCatalog({ status: "not_checked", reason: cat.reason }, ctx.now);
  return {
    kind: r.kind,
    status: r.confidence >= REVIEW_THRESHOLD ? "confirmed" : "needs_review",
    scanId: ctx.scanId,
    title: buildTitle(r),
    ...read,
    yearEnd: r.kind === "bulk" ? r.yearEnd : null,
    fieldSources: JSON.stringify(marks),
    catalogCandidates,
    firstSuggestion: buildFirstSuggestion(cardRead, {
      confidence: r.confidence, reader: ctx.recognizer ?? null, at: ctx.now, unsure: isCard ? unsureFields(r) : [],
      hold: isCard ? r.evidence?.hold ?? [] : [], notRead: isCard ? r.evidence?.notRead ?? [] : [],
    }),
    ...rookieFromScan(isCard, r.isRookie, r.evidence),
    isError: isCard && r.isError,
    isParallel: isCard && r.isParallel,
    isInsert: isCard && r.isInsert,
    isAutograph: isCard && r.isAutograph,
    isMemorabilia: isCard && r.isMemorabilia,
    // A scan never writes the serial number or its parts: what it read waits for the owner's answer.
    serialNumber: null,
    serialCopy: null,
    serialEdition: null,
    serialSuggested: serialSuggestion,
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

/** The fields the reader filled but was not sure of (see ReadEvidence.certainty). */
function unsureFields(r: RecognizedItem): CatalogField[] {
  const c = r.evidence?.certainty;
  if (!c) return [];
  return CERTAIN_FIELDS.filter((f) => c[f] === "unsure");
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
