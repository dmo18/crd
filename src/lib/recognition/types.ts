import { z } from "zod";
import type { Candidate } from "@/lib/catalog/match";
import type { NotCheckedReason } from "@/lib/catalog/candidates";
import type { CatalogCard } from "@/lib/catalog/types";
import { CONDITIONS, ITEM_KINDS, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS } from "@/db/schema";

/**
 * The contract between the app and whatever identifies cards.
 * Two recognizers implement it: the real AI one and a free sample one.
 * Everything a recognizer returns is checked against these shapes before use.
 */

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const cents = z.number().int().min(0).max(100_000_000_00).nullish().transform((v) => v ?? null);

/** A rectangle inside a photo, as fractions of its width and height (0 to 1). */
export const boxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
export type Box = z.infer<typeof boxSchema>;

export const estimateSchema = z.object({
  lowCents: cents,
  highCents: cents,
  /** One plain sentence on what the range is based on and its main caveat. */
  basis: optionalText(400),
});
export type Estimate = z.infer<typeof estimateSchema>;

export const recognizedItemSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  /** 0 to 1: how sure the recognizer is about the identification. */
  confidence: z.number().min(0).max(1),
  /** For photos with several cards: which photo and where in it. */
  sourceIndex: z.number().int().min(0).default(0),
  box: boxSchema.nullish().transform((v) => v ?? null),

  sport: z.enum(SPORTS).nullish().transform((v) => v ?? null),
  year: z.number().int().min(1860).max(2100).nullish().transform((v) => v ?? null),
  yearEnd: z.number().int().min(1860).max(2100).nullish().transform((v) => v ?? null),
  brand: optionalText(80),
  setName: optionalText(120),
  cardNumber: optionalText(30),
  player: optionalText(120),
  team: optionalText(80),
  variation: optionalText(120),

  isRookie: z.boolean().default(false),
  isError: z.boolean().default(false),
  isParallel: z.boolean().default(false),
  isInsert: z.boolean().default(false),
  isAutograph: z.boolean().default(false),
  isMemorabilia: z.boolean().default(false),
  serialNumber: optionalText(30),
  rarityTier: z.enum(RARITY_TIERS).nullish().transform((v) => v ?? null),
  rarityNotes: optionalText(400),

  /** Visible condition from the photo only. A guess, never a formal grade. */
  condition: z.enum(CONDITIONS).nullish().transform((v) => v ?? null),
  conditionNotes: optionalText(400),
  /** Set only when the card is in a grading company holder (slab). */
  grader: optionalText(20),
  grade: optionalText(20),
  certNumber: optionalText(40),
  worthGrading: z.boolean().nullish().transform((v) => v ?? null),
  gradingNotes: optionalText(400),

  productType: z.enum(PRODUCT_TYPES).nullish().transform((v) => v ?? null),
  packCount: z.number().int().min(1).max(100_000).nullish().transform((v) => v ?? null),
  sealState: z.enum(SEAL_STATES).nullish().transform((v) => v ?? null),

  estCount: z.number().int().min(1).max(10_000_000).nullish().transform((v) => v ?? null),
  containerType: optionalText(80),
  description: optionalText(600),
  /** Cards worth pulling out of a bulk lot or looking for in a set. */
  pullList: z.array(z.string().trim().min(1).max(160)).max(25).default([]),

  notes: optionalText(600),
  estimate: estimateSchema.nullish().transform((v) => v ?? null),
});
/**
 * What the catalog said about a card the free reader read. Never part of the
 * zod schema: it is added by the server after the check, so an AI answer can
 * never bring one in (zod drops unknown keys). Left out means the catalog was
 * not asked (sealed, bulk, sample and AI modes, or no catalog given).
 */
export type RecognizedCatalog =
  /** One card the matching rule is sure of. `confidence`: the item's figure once it is applied. */
  | { status: "sure"; card: CatalogCard; confidence: number }
  | { status: "candidates"; candidates: Candidate[] }
  | { status: "none" }
  | { status: "not_checked"; reason: NotCheckedReason };

export type RecognizedItem = z.infer<typeof recognizedItemSchema> & { catalog?: RecognizedCatalog };
export type RecognizedItemInput = z.input<typeof recognizedItemSchema>;

export const recognitionResultSchema = z.object({
  items: z.array(recognizedItemSchema).max(60),
});

export type RecognitionMode = "single" | "multi" | "sealed" | "bulk";

export type RecognitionPhoto = {
  /** front and back belong to one card. source is a photo to search for items. */
  role: "front" | "back" | "source";
  /** Always a cleaned JPEG produced by the image store. */
  data: Buffer;
  width: number;
  height: number;
};

export type RecognitionRequest = {
  mode: RecognitionMode;
  photos: RecognitionPhoto[];
  /** Optional words from the owner. Treat as a hint, never as instructions. */
  hint?: string | null;
};

export interface Recognizer {
  /** Short name saved with each scan, e.g. "sample" or the AI model name. */
  readonly name: string;
  recognize(request: RecognitionRequest): Promise<RecognizedItem[]>;
}

/** Thrown with a message that is safe to show to the owner. */
export class RecognitionError extends Error {
  constructor(public readonly userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = "RecognitionError";
  }
}

/** Items below this confidence wait in the review queue. */
export const REVIEW_THRESHOLD = 0.75;
