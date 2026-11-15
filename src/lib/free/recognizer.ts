import sharp from "sharp";
import type { Sport } from "@/db/schema";
import { checkPhotoCount } from "@/lib/recognition/limits";
import {
  recognizedItemSchema,
  type Box,
  type RecognitionPhoto,
  type RecognitionRequest,
  type RecognizedItem,
  type RecognizedItemInput,
  type Recognizer,
} from "@/lib/recognition/types";
import { findCardBoxes } from "./find-cards";
import { findKeyCard, keyCardsFor, type KeyCard } from "./key-cards";
import { getTextReader, type OcrResult, type ReadOptions, type TextReader } from "./ocr";
import { parseCardText, parseProductText, type ParsedCard } from "./parse";
import { lookupPlayer, type PlayerFacts } from "./wikidata";

/**
 * Free card reading with no keys and no paid services:
 * 1. find each card in the photo (many-card mode),
 * 2. read the printed text on this server,
 * 3. turn the text into year, brand, number and player,
 * 4. check the built-in list of key cards and look the player up on Wikidata.
 * Values are left empty on purpose: the owner checks sold listings.
 */

export type FreeDeps = {
  reader?: TextReader;
  findBoxes?: (image: Buffer) => Promise<Box[]>;
  lookup?: (name: string, opts: { sport?: Sport | null; year?: number | null }) => Promise<PlayerFacts | null>;
};

const MAX_CARDS_PER_PHOTO = 30;
const MAX_LOOKUPS_PER_CARD = 2;
const FREE_NOTE = "Read with free text recognition. Check the details, then add a value from sold listings.";
const UNREAD_NOTE = "Could not read the printed text clearly. Fill in the details by hand, or try a sharper photo without glare.";

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

async function cropPhoto(photo: RecognitionPhoto, box: Box): Promise<Buffer> {
  const left = Math.floor(clamp01(box.x) * photo.width);
  const top = Math.floor(clamp01(box.y) * photo.height);
  const width = Math.max(16, Math.min(photo.width - left, Math.round(box.w * photo.width)));
  const height = Math.max(16, Math.min(photo.height - top, Math.round(box.h * photo.height)));
  return sharp(photo.data).extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer();
}

function formatKeyCard(k: KeyCard): string {
  const flags = [k.isRookie ? "rookie" : null, k.isError ? "error" : null, k.variation].filter(Boolean).join(", ");
  return `${k.year} ${k.setName} #${k.cardNumber} ${k.player}${flags ? ` (${flags})` : ""}`;
}

export class FreeRecognizer implements Recognizer {
  readonly name = "free";
  private readonly reader: TextReader;
  private readonly findBoxes: (image: Buffer) => Promise<Box[]>;
  private readonly lookup: NonNullable<FreeDeps["lookup"]>;

  constructor(deps: FreeDeps = {}) {
    this.reader = deps.reader ?? getTextReader();
    this.findBoxes = deps.findBoxes ?? findCardBoxes;
    this.lookup = deps.lookup ?? ((name, opts) => lookupPlayer(name, opts));
  }

  async recognize(request: RecognitionRequest): Promise<RecognizedItem[]> {
    checkPhotoCount(request);
    switch (request.mode) {
      case "single": return [await this.single(request.photos)];
      case "multi": return this.multi(request.photos);
      case "sealed": return [await this.product(request.photos, "sealed")];
      case "bulk": return [await this.product(request.photos, "bulk")];
    }
  }

  private async read(image: Buffer, options?: ReadOptions): Promise<OcrResult | null> {
    try {
      return await this.reader.read(image, options);
    } catch {
      return null;
    }
  }

  private async single(photos: RecognitionPhoto[]): Promise<RecognizedItem> {
    const front = photos.find((p) => p.role === "front") ?? photos[0];
    const back = photos.find((p) => p.role === "back");
    const frontText = await this.read(front.data);
    const backText = back ? await this.read(back.data) : null;
    return this.cardFromText(frontText, backText, { sourceIndex: 0, box: null });
  }

  private async multi(photos: RecognitionPhoto[]): Promise<RecognizedItem[]> {
    const out: RecognizedItem[] = [];
    for (const [index, photo] of photos.entries()) {
      let boxes: Box[] = [];
      try {
        boxes = (await this.findBoxes(photo.data)).slice(0, MAX_CARDS_PER_PHOTO);
      } catch {
        boxes = [];
      }
      if (boxes.length === 0) {
        // No separate cards found: treat the whole photo as one card.
        out.push(await this.cardFromText(await this.read(photo.data), null, { sourceIndex: index, box: null }));
        continue;
      }
      for (const box of boxes) {
        let text: OcrResult | null = null;
        try {
          text = await this.read(await cropPhoto(photo, box));
        } catch {
          text = null;
        }
        out.push(await this.cardFromText(text, null, { sourceIndex: index, box }));
      }
    }
    return out;
  }

  private async findPlayer(parsed: ParsedCard): Promise<PlayerFacts | null> {
    for (const name of parsed.playerCandidates.slice(0, MAX_LOOKUPS_PER_CARD)) {
      try {
        const facts = await this.lookup(name, { sport: parsed.sport, year: parsed.year });
        if (facts) return facts;
      } catch {
        // Wikidata is a bonus. A failed lookup never fails a scan.
      }
    }
    return null;
  }

  private async cardFromText(
    front: OcrResult | null,
    back: OcrResult | null,
    where: { sourceIndex: number; box: Box | null },
  ): Promise<RecognizedItem> {
    const parsed = parseCardText(front, back);
    const readAnything = parsed.year != null || parsed.brand != null || parsed.cardNumber != null || parsed.playerCandidates.length > 0;
    if (!readAnything) {
      return recognizedItemSchema.parse({ kind: "card", confidence: 0.05, ...where, notes: UNREAD_NOTE });
    }

    // 1. The built-in key card list: an exact match is strong evidence.
    let key: KeyCard | null = findKeyCard({ year: parsed.year, brand: parsed.brand, cardNumber: parsed.cardNumber, sport: parsed.sport });
    for (const name of parsed.playerCandidates) {
      if (key) break;
      key = findKeyCard({ year: parsed.year, brand: parsed.brand, player: name, sport: parsed.sport });
    }

    // 2. Wikidata, to confirm the player and fill in the sport.
    const facts = key ? null : await this.findPlayer(parsed);

    const notes = [...parsed.evidence];
    const item: RecognizedItemInput = {
      kind: "card",
      confidence: 0,
      ...where,
      sport: key?.sport ?? parsed.sport ?? facts?.sports[0] ?? null,
      year: key?.year ?? parsed.year,
      brand: key?.brand ?? parsed.brand,
      setName: key?.setName ?? parsed.setName,
      cardNumber: key?.cardNumber ?? parsed.cardNumber,
      player: key?.player ?? facts?.name ?? parsed.playerCandidates[0] ?? null,
      team: parsed.team,
      variation: key?.variation ?? null,
      isRookie: key?.isRookie ?? false,
      isError: key?.isError ?? false,
      serialNumber: parsed.serialNumber,
      grader: parsed.grader,
      grade: parsed.grade,
      certNumber: parsed.certNumber,
      rarityTier: key?.tier ?? (facts?.hallOfFame ? "star" : null),
      rarityNotes: key?.note ?? null,
      estimate: null,
    };

    if (key) {
      notes.push("Matched a card on the built-in list of key cards.");
    } else if (facts) {
      notes.push(`Player confirmed on Wikidata: ${facts.name}${facts.description ? `, ${facts.description}` : ""}.`);
      if (facts.hallOfFame) item.rarityNotes = "Hall of Fame player. Cards of Hall of Famers usually sell for more.";
      const year = item.year;
      if (year != null && facts.careerStart != null && year - facts.careerStart >= 0 && year - facts.careerStart <= 1) {
        const hint = "The card year matches this player's first seasons, so it may be a rookie card. Check before relying on it.";
        item.rarityNotes = item.rarityNotes ? `${item.rarityNotes} ${hint}` : hint;
      }
    }
    notes.push(FREE_NOTE);
    item.notes = notes.join(" ").slice(0, 600);

    // Confidence comes from how much was read and confirmed, then is held
    // back when the text itself was hard to read.
    // Without a key card or a Wikidata match the best possible is 0.7, so it
    // waits in Review for a quick check.
    let confidence = key ? 0.9 : 0.05;
    if (!key) {
      if (item.year != null) confidence += 0.2;
      if (item.brand) confidence += 0.2;
      if (item.cardNumber) confidence += 0.15;
      if (item.player) confidence += 0.1;
      if (facts) confidence += 0.15;
    }
    const textConfidence = Math.max(front?.confidence ?? 0, back?.confidence ?? 0);
    if (textConfidence < 0.5) confidence = Math.min(confidence, 0.6);
    item.confidence = Math.min(0.95, confidence);
    return recognizedItemSchema.parse(item);
  }

  private async product(photos: RecognitionPhoto[], kind: "sealed" | "bulk"): Promise<RecognizedItem> {
    const texts = (await Promise.all(photos.map((p) => this.read(p.data, { thorough: true })))).filter((t): t is OcrResult => t !== null);
    const merged: OcrResult = {
      text: texts.map((t) => t.text).join("\n"),
      lines: texts.flatMap((t) => t.lines),
      confidence: texts.length ? Math.max(...texts.map((t) => t.confidence)) : 0,
    };
    const parsed = parseProductText(merged);
    const pulls = keyCardsFor({ year: parsed.year, yearEnd: parsed.yearEnd, brand: parsed.brand, sport: parsed.sport })
      .slice(0, 12)
      .map(formatKeyCard);

    let confidence = 0.2;
    if (parsed.year != null) confidence += 0.3;
    if (parsed.brand) confidence += 0.3;
    if (kind === "sealed" && parsed.productType) confidence += 0.1;
    if (kind === "bulk" && parsed.estCount != null) confidence += 0.1;
    if (merged.confidence < 0.5) confidence = Math.min(confidence, 0.6);

    const notes = [...parsed.evidence];
    if (kind === "sealed") notes.push("Seal state was not checked automatically. Look for loose wrap or extra glue before buying or selling.");
    if (kind === "bulk" && parsed.estCount == null) notes.push("No count was printed on the box. Enter your own count.");
    if (pulls.length) notes.push("The list below comes from the built-in key card list for these years and brands.");
    notes.push(FREE_NOTE);

    return recognizedItemSchema.parse({
      kind,
      confidence: Math.min(0.9, confidence),
      sourceIndex: 0,
      box: null,
      sport: parsed.sport,
      year: parsed.year,
      yearEnd: kind === "bulk" ? parsed.yearEnd : null,
      brand: parsed.brand,
      setName: parsed.setName,
      productType: kind === "sealed" ? parsed.productType : null,
      packCount: kind === "sealed" ? parsed.packCount : null,
      sealState: kind === "sealed" ? "unknown" : null,
      estCount: kind === "bulk" ? parsed.estCount : null,
      containerType: kind === "bulk" ? parsed.containerType : null,
      pullList: pulls,
      notes: notes.join(" ").slice(0, 600),
      estimate: null,
    } satisfies RecognizedItemInput);
  }
}
