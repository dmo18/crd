import Anthropic from "@anthropic-ai/sdk";
import { CONDITIONS, ITEM_KINDS, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS } from "@/db/schema";
import { env } from "@/lib/env";
import { checkPhotoCount } from "./limits";
import { SYSTEM_PROMPT, buildInstructions, photoLabel } from "./prompt";
import {
  RecognitionError,
  recognitionResultSchema,
  recognizedItemSchema,
  type Box,
  type RecognitionRequest,
  type RecognizedItem,
  type Recognizer,
} from "./types";

/** Most capable current vision model, per the Claude API reference. Override with ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const REQUEST_TIMEOUT_MS = 90_000;
export const MAX_RETRIES = 2;
/** Room for up to 60 items of about 300 tokens each, plus the model's own thinking. */
export const MAX_TOKENS = 32_000;
/** Boxes thinner than this (as a fraction of the photo) are dropped as useless. */
const MIN_BOX_SIDE = 0.01;

export const MESSAGES = {
  keyRejected: "The AI key was rejected. Check the API key in settings.",
  busy: "The AI service is busy. Try again in a minute.",
  network: "Could not reach the AI service. Check the connection and try again.",
  unreadable: "The AI could not read this photo. Try a sharper, well lit photo.",
  generic: "Something went wrong reading this photo. Try again.",
} as const;

type RequestOptions = { timeout?: number; maxRetries?: number };

/** The one SDK method this recognizer uses. Tests pass a fake that matches it. */
export interface MinimalClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: RequestOptions): PromiseLike<Anthropic.Message>;
  };
}

export type AnthropicRecognizerOptions = {
  client?: MinimalClient;
  apiKey?: string;
  model?: string;
};

/*
 * JSON schema sent as the structured output format.
 *
 * It mirrors `recognitionResultSchema` in types.ts by hand. The zod schema
 * remains the source of truth: the response is ALWAYS re-validated with
 * `recognizedItemSchema` and `recognitionResultSchema` before anything is used.
 *
 * Structured output schemas do not support min, max or length limits, so
 * those live only in zod. Every field is required to keep the schema simple
 * for the API: unknown text is sent as an empty string (zod turns it into
 * null) and only numbers, enums and objects use null. This keeps the number of
 * union typed fields small.
 */
const text = (description: string) => ({ type: "string", description });
const nullableInt = (description: string) => ({ type: ["integer", "null"], description });
const nullableEnum = (values: readonly string[], description: string) => ({ enum: [...values, null], description });
const flag = (description: string) => ({ type: "boolean", description });

const itemProperties = {
  kind: { enum: [...ITEM_KINDS], description: "card, sealed or bulk" },
  confidence: { type: "number", description: "0 to 1, how sure the identification is" },
  sourceIndex: { type: "integer", description: "Number of the photo this item is in, starting at 0" },
  box: {
    anyOf: [
      {
        type: "object",
        description: "Where the item is in its photo, as fractions of width and height, origin top left",
        properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
        required: ["x", "y", "w", "h"],
        additionalProperties: false,
      },
      { type: "null" },
    ],
  },
  sport: nullableEnum(SPORTS, "Sport, or null"),
  year: nullableInt("Card or product year, or null when not readable or known"),
  yearEnd: nullableInt("Last year of a range for bulk lots, else null"),
  brand: text("Brand, empty when unknown"),
  setName: text("Set name, empty when unknown"),
  cardNumber: text("Card number as printed, empty when not readable"),
  player: text("Player name, empty when unknown"),
  team: text("Team, empty when unknown"),
  variation: text("Subset, parallel or variation name, empty when none"),
  isRookie: flag("Rookie card"),
  isError: flag("Known error or variation visible on this copy"),
  isParallel: flag("Parallel version"),
  isInsert: flag("Insert card"),
  isAutograph: flag("Signed card"),
  isMemorabilia: flag("Contains a piece of jersey or other memorabilia"),
  serialNumber: text("Printed serial number such as 045/100, empty when none"),
  rarityTier: nullableEnum(RARITY_TIERS, "Rarity tier, or null"),
  rarityNotes: text("Why it matters, empty when nothing to say"),
  condition: nullableEnum(CONDITIONS, "Visible condition guess, or null"),
  conditionNotes: text("What is visible: corners, edges, centering, surface, creases"),
  grader: text("Grading company on a slab label, empty for raw cards"),
  grade: text("Grade on a slab label, empty for raw cards"),
  certNumber: text("Certification number on a slab label, empty for raw cards"),
  worthGrading: { type: ["boolean", "null"], description: "Could grading fees pay off, or null when unknown" },
  gradingNotes: text("Short reason for worthGrading"),
  productType: nullableEnum(PRODUCT_TYPES, "Sealed product type, or null"),
  packCount: nullableInt("Packs in a sealed product, or null"),
  sealState: nullableEnum(SEAL_STATES, "Seal state for sealed products, or null"),
  estCount: nullableInt("Estimated number of cards in a bulk lot, or null"),
  containerType: text("Bulk container, empty when not bulk"),
  description: text("Short description, mainly for sealed and bulk items"),
  pullList: { type: "array", items: { type: "string" }, description: "Specific cards worth pulling or looking for" },
  notes: text("Other notes, including assumptions"),
  estimate: {
    anyOf: [
      {
        type: "object",
        properties: {
          lowCents: nullableInt("Low end in whole US cents for one unit"),
          highCents: nullableInt("High end in whole US cents for one unit"),
          basis: text("One sentence: AI estimate and the main value driver"),
        },
        required: ["lowCents", "highCents", "basis"],
        additionalProperties: false,
      },
      { type: "null" },
    ],
  },
};

export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: itemProperties,
        required: Object.keys(itemProperties),
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Keeps a box inside the photo. Returns null when it is missing, broken or too thin. */
export function normaliseBox(raw: unknown): Box | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = [r.x, r.y, r.w, r.h];
  if (!nums.every((n): n is number => typeof n === "number" && Number.isFinite(n))) return null;
  let [x, y, w, h] = nums as number[];
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(Math.max(w, 0), 1 - x);
  h = Math.min(Math.max(h, 0), 1 - y);
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) return null;
  return { x, y, w, h };
}

/** Turns any failure from the AI call into a message that is safe to show. */
export function toRecognitionError(err: unknown): RecognitionError {
  if (err instanceof RecognitionError) return err;
  const name = err instanceof Error ? err.name : "";
  if (err instanceof Anthropic.APIConnectionError || name === "AbortError" || name === "TimeoutError") {
    return new RecognitionError(MESSAGES.network, { cause: err });
  }
  const status = err && typeof err === "object" && "status" in err ? (err as { status: unknown }).status : undefined;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return new RecognitionError(MESSAGES.keyRejected, { cause: err });
    if (status === 429 || status === 529 || status === 503) return new RecognitionError(MESSAGES.busy, { cause: err });
    if (status === 408 || status === 504) return new RecognitionError(MESSAGES.network, { cause: err });
  }
  return new RecognitionError(MESSAGES.generic, { cause: err });
}

export class AnthropicRecognizer implements Recognizer {
  readonly name: string;
  private client: MinimalClient | undefined;
  private readonly apiKey: string | undefined;

  constructor(options: AnthropicRecognizerOptions = {}) {
    this.client = options.client;
    this.apiKey = options.apiKey;
    this.name = options.model ?? env().ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  }

  private getClient(): MinimalClient {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.apiKey ?? env().ANTHROPIC_API_KEY,
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
      });
    }
    return this.client;
  }

  /** The request body, kept separate so tests can check it without a call. */
  buildRequest(request: RecognitionRequest): Anthropic.MessageCreateParamsNonStreaming {
    const content: Anthropic.ContentBlockParam[] = [];
    request.photos.forEach((photo, i) => {
      content.push({ type: "text", text: photoLabel(i, photo) });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: photo.data.toString("base64") },
      });
    });
    content.push({ type: "text", text: buildInstructions(request.mode, request.photos.length, request.hint) });
    return {
      model: this.name,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: RESPONSE_JSON_SCHEMA } },
    };
  }

  async recognize(request: RecognitionRequest): Promise<RecognizedItem[]> {
    checkPhotoCount(request);
    const body = this.buildRequest(request);

    let message: Anthropic.Message;
    try {
      message = await this.getClient().messages.create(body, { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    } catch (err) {
      throw toRecognitionError(err);
    }

    if (message.stop_reason === "refusal") throw new RecognitionError(MESSAGES.unreadable);
    const rawItems = parseRawItems(message);
    const valid: RecognizedItem[] = [];
    for (const raw of rawItems) {
      // Clamp the box first so a slightly-off box does not cost the whole item.
      const prepared = raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>), box: normaliseBox((raw as Record<string, unknown>).box) }
        : raw;
      const parsed = recognizedItemSchema.safeParse(prepared);
      if (parsed.success) valid.push(parsed.data);
    }
    if (rawItems.length > 0 && valid.length === 0) throw new RecognitionError(MESSAGES.unreadable);

    const cleaned = postProcess(valid, request);
    const result = recognitionResultSchema.safeParse({ items: cleaned.slice(0, 60) });
    if (!result.success) throw new RecognitionError(MESSAGES.unreadable, { cause: result.error });
    return result.data.items;
  }
}

/** Pulls the items list out of the model's JSON text. Never echoes the text in errors. */
function parseRawItems(message: Anthropic.Message): unknown[] {
  const textOut = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(textOut);
  } catch {
    throw new RecognitionError(MESSAGES.unreadable);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new RecognitionError(MESSAGES.unreadable);
  }
  return (parsed as { items: unknown[] }).items;
}

/** Fixes small mistakes the schema cannot catch, based on the scan mode and photos. */
export function postProcess(items: RecognizedItem[], request: RecognitionRequest): RecognizedItem[] {
  const lastPhoto = request.photos.length - 1;
  let out = items.map((item) => {
    const next: RecognizedItem = { ...item };
    if (request.mode === "single") next.kind = "card";
    if (request.mode === "sealed") next.kind = "sealed";
    if (request.mode === "bulk") next.kind = "bulk";
    next.box = normaliseBox(next.box);
    if (next.sourceIndex > lastPhoto) {
      next.sourceIndex = lastPhoto;
      next.box = null;
    }
    const est = next.estimate;
    if (est && est.lowCents !== null && est.highCents !== null && est.lowCents > est.highCents) {
      next.estimate = { ...est, lowCents: est.highCents, highCents: est.lowCents };
    }
    return next;
  });
  if (request.mode === "single" && out.length > 1) {
    const best = out.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    out = [best];
  }
  return out;
}
