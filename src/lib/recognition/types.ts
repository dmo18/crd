import { z } from "zod";
import type { Candidate } from "@/lib/catalog/match";
import type { NotCheckedReason } from "@/lib/catalog/candidates";
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
  | { status: "candidates"; candidates: Candidate[] }
  /**
   * Exactly one verified match (S1a rule C): the scan links `candidates[0]`
   * as the owner's "This is my card" would, with Undo on the item page.
   */
  | { status: "matched"; candidates: Candidate[] }
  | { status: "none" }
  | { status: "not_checked"; reason: NotCheckedReason };

/**
 * What the reader saw that the owner is asked about. Like `catalog`, never part
 * of the zod schema: the server adds it after the reading, so an AI answer can
 * never bring one in. Nothing here is written to the item as a fact: a scan
 * writes only a key list hit for the rookie mark, and never a serial number.
 */
export type ReadEvidence = {
  /** The built-in key card list had this very card. `isRookie` is the list's answer. Passed explicitly, never inferred. */
  keyCard?: { isRookie: boolean };
  /** The card says REPRINT. */
  reprint?: boolean;
  /** The word ROOKIE or RC was read on the card. */
  rookieWord?: boolean;
  /** A serial number as the reader saw it. */
  serial?: { text: string; line: string; weak: boolean; why: string[] };
  /**
   * Per filled field, how sure the free reader is (12R.5 round 2): "sure"
   * only when two independent signs on the card agree, else "unsure". Unsure
   * fields are marked "Check this" for the owner. Left out by readers that
   * do not say (AI, sample).
   */
  certainty?: FieldCertainty;
  /**
   * Why this card must wait for the owner whatever the catalog says (the
   * free reader's hold backs). A catalog link never lifts such a card to
   * confirmed. See HOLD_REASONS.
   */
  hold?: HoldReason[];
  /** Filled fields whose value did not come from reading the card (the key card list, Wikidata). */
  notRead?: CertainField[];
  /** Fields that were blank and were filled from the catalog's set list (rule D), not read from the card. */
  checklist?: ("player" | "team" | "cardNumber")[];
};

/**
 * The reasons a read card always waits for the owner:
 * - reprint: the card says REPRINT (never the original);
 * - one_side: one side of a card from a many-cards scan, left without its partner;
 * - hard_to_read: the text itself was hard to read;
 * - error_check: the card may be a listed error version, which text cannot tell;
 * - key_list_guess: only a possible key list card, its player or number not read;
 * - front_twice: a one card scan whose second photo shows the front again.
 */
export const HOLD_REASONS = ["reprint", "one_side", "hard_to_read", "error_check", "key_list_guess", "front_twice"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Shown on the scan result and the item when both photos of a one card scan show the front. */
export const FRONT_TWICE = "Both photos show the front. Add a photo of the back to get the year and number.";

/** Plain words for each hold reason, shown on the item. */
export const HOLD_WORDS: Record<HoldReason, string> = {
  reprint: "Marked REPRINT, so it is not the original card. Check it yourself.",
  one_side: "Only one side of this card was matched in a many-cards scan. Check it yourself.",
  hard_to_read: "The text on the card was hard to read. Check it yourself.",
  error_check: "This may be a known error version, which the reader cannot tell. Check it yourself.",
  key_list_guess: "Only a possible key card: the player or number was not read. Check it yourself.",
  front_twice: FRONT_TWICE,
};

/** The fields a reader may say it is sure of. */
export const CERTAIN_FIELDS = ["sport", "year", "brand", "setName", "cardNumber", "player", "team"] as const;
export type CertainField = (typeof CERTAIN_FIELDS)[number];
export type FieldCertainty = Partial<Record<CertainField, "sure" | "unsure">>;

/**
 * Where the back of a card from a many-card scan was found, when the free
 * reader paired it with its front (12R.7): the scan stores that part of the
 * photo as the card's back. Like `catalog`, never part of the zod schema.
 */
export type BackPhoto = { sourceIndex: number; box: Box };

/**
 * What the free reader found out about how to show one photo (S1b): where the
 * card sits in the photo, and the turn (degrees clockwise, 0 90 180 270) that
 * makes the text upright. Boxes are fractions of the photo the reader was
 * given. The two flags say how far each can be trusted: the card finder fails
 * when the photo is all card and can be fooled by glare; the turn is trusted
 * when enough text lines agree. `lines` are the text boxes the reader used.
 */
export type ReadFix = {
  turn: 0 | 90 | 180 | 270;
  turnTrusted: boolean;
  card: Box | null;
  cardTrusted: boolean;
  lines: Box[];
};

/**
 * The fix for one input photo of a scan. `sourceIndex` is the position of the
 * photo in the request. In many-cards mode the photo is a card cut from it:
 * `role` says whether that is the item's front or its back, and only the turn
 * is used. Like `catalog`, never part of the zod schema.
 */
export type PhotoFix = ReadFix & { sourceIndex: number; role: "front" | "back" };

/**
 * Many cards: how each side's cut-out was made from its photo (its outline
 * and tilt; see src/lib/free/cut-out.ts), so the stored picture is the very
 * picture that was read. Like `fixes`, never part of the zod schema.
 */
export type CardCuts = { front?: CardCutRecord; back?: CardCutRecord };
export type CardCutRecord = { box: Box; outline: [number, number][]; tilt: number };

export type RecognizedItem = z.infer<typeof recognizedItemSchema> & {
  catalog?: RecognizedCatalog; evidence?: ReadEvidence; backPhoto?: BackPhoto; fixes?: PhotoFix[]; cuts?: CardCuts;
  /**
   * Many cards: the side the item's own cut-out shows. Left out: its front.
   * "back" for a card read from its back alone. Like `cuts`, never part of the zod schema.
   */
  cropSide?: "front" | "back";
};
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
