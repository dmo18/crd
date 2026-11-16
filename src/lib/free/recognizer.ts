import sharp from "sharp";
import type { Sport } from "@/db/schema";
import { createScanBudget, lookupCard, lookupConfidence, type LookupResult } from "@/lib/catalog/lookup";
import type { Catalog } from "@/lib/catalog/types";
import { checkPhotoCount } from "@/lib/recognition/limits";
import {
  CERTAIN_FIELDS,
  recognizedItemSchema,
  type FieldCertainty,
  type Box,
  type RecognitionPhoto,
  type RecognitionRequest,
  type ReadEvidence,
  type RecognizedItem,
  type RecognizedCatalog,
  type RecognizedItemInput,
  type Recognizer,
} from "@/lib/recognition/types";
import { cardTilt, findCardBoxes } from "./find-cards";
import { keyCardsFor, matchKeyCard, normalizeBrand, normalizeName, type KeyCard } from "./key-cards";
import { getTextReader, type OcrResult, type ReadOptions, type TextReader } from "./ocr";
import { parseCardText, parseProductText, teamFromList, type ParsedCard } from "./parse";
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
  /** Degrees a cropped card is turned from upright, clockwise positive. */
  tilt?: (image: Buffer) => Promise<number>;
  lookup?: (name: string, opts: { sport?: Sport | null; year?: number | null }) => Promise<PlayerFacts | null>;
  /**
   * The card catalog. When given, each read card is looked up after the
   * reading, in the `background` line, within the scan's call budget.
   * Left out: no catalog call at all, the reading stands as it is.
   */
  catalog?: Catalog;
  /** Longest time the catalog part of one scan may take. */
  catalogTimeMs?: number;
  /** Milliseconds now; tests pass a fake clock. */
  clock?: () => number;
};

/** A card as read, with the name spellings the catalog look up may try. */
type ReadCard = { item: RecognizedItem; names: string[]; yearFromStats?: boolean };

const MAX_CARDS_PER_PHOTO = 30;
const MAX_LOOKUPS_PER_CARD = 2;
/** Cards turned less than this are read as they are. */
const MIN_STRAIGHTEN_DEG = 5;
const FREE_NOTE = "Read with free text recognition. Check the details, then add a value from sold listings.";
const UNREAD_NOTE = "Could not read the printed text clearly. Fill in the details by hand, or try a sharper photo without glare.";
const ADD_BACK_NOTE = "Add a photo of the back; the year and number are usually there.";
const KEY_CONFIDENCE = 0.9;
/** Below the review line (REVIEW_THRESHOLD), so the owner checks it. */
const CHECK_CONFIDENCE = 0.7;
const MAX_WITHOUT_KEY = 0.8;
/**
 * The catalog part of a scan stops starting look ups after this long, so the
 * whole scan stays well inside its 5 minute limit. Cards after that keep the
 * plain reading and show "Catalog not checked" in Review.
 */
export const CATALOG_TIME_MS = 2 * 60 * 1000;
/**
 * And never later than this after the scan's reading began: the scan has 5
 * minutes in all (RECOGNITION_DEADLINE_MS), and the catalog must never be
 * the reason a scan runs out of time.
 */
export const CATALOG_LATEST_MS = 4 * 60 * 1000;
const TIMED_OUT = Symbol("timed out");

/** Resolves like `work`, or with TIMED_OUT after `ms`. The timer is always cleared. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The catalog with a stop switch. lookupCard has no way to be told to stop, so
 * when the scan's catalog time runs out the switch is thrown and every catalog
 * call the look up in progress makes after that is refused at once (no network
 * call). The one call already in flight when time ran out may still finish.
 */
function stoppable(inner: Catalog): Catalog & { stop(): void } {
  let stopped = false;
  const refused = { ok: false as const, reason: "busy" as const, tries: 0 };
  return {
    stop() { stopped = true; },
    search: (q, line, limits) => (stopped ? Promise.resolve(refused) : inner.search(q, line, limits)),
    card: (id, line, limits) => (stopped ? Promise.resolve(refused) : inner.card(id, line, limits)),
    checklist: (id, line, limits) => (stopped ? Promise.resolve(refused) : inner.checklist(id, line, limits)),
  };
}

/**
 * Owner safety rule (PLAN, 10.6 after the fifth review): no catalog card is
 * ever filled without the owner's tap. A "sure" answer from the look up only
 * moves that card to the top of the suggestions. Switch on again only with
 * a new review of the sure rule.
 */
export const AUTO_FILL_SURE = false;

/** The look up's answer as the catalog part of a recognized card. */
export function catalogPart(result: LookupResult, readingConfidence: number, autoFill = AUTO_FILL_SURE): RecognizedCatalog {
  if (result.sure && autoFill) return { status: "sure", card: result.sure, confidence: lookupConfidence(result, readingConfidence) };
  if (result.sure) {
    const sure = result.sure;
    return { status: "candidates", candidates: [sure, ...result.candidates.filter((c) => c.sourceId !== sure.sourceId)] };
  }
  if (result.candidates.length > 0) return { status: "candidates", candidates: result.candidates };
  if (result.stopped) return { status: "not_checked", reason: result.stopped };
  return { status: "none" };
}

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

/**
 * The no name on front error is ruled out when the player's name was read on the front.
 * Other errors (a reversed photo, a word on a bat knob) cannot be told from text.
 */
function ruledOutOnFront(error: KeyCard, card: KeyCard, front: OcrResult | null): boolean {
  if (!/no name/i.test(error.variation ?? "")) return false;
  const text = normalizeName(front?.text ?? "");
  const name = normalizeName(card.player);
  return name.length > 0 && ` ${text} `.includes(` ${name} `);
}

export class FreeRecognizer implements Recognizer {
  readonly name = "free";
  private readonly reader: TextReader;
  private readonly findBoxes: (image: Buffer) => Promise<Box[]>;
  private readonly lookup: NonNullable<FreeDeps["lookup"]>;
  private readonly tilt: NonNullable<FreeDeps["tilt"]>;
  private readonly catalog: Catalog | undefined;
  private readonly catalogTimeMs: number;
  private readonly clock: () => number;

  constructor(deps: FreeDeps = {}) {
    this.reader = deps.reader ?? getTextReader();
    this.findBoxes = deps.findBoxes ?? findCardBoxes;
    this.lookup = deps.lookup ?? ((name, opts) => lookupPlayer(name, opts));
    this.tilt = deps.tilt ?? cardTilt;
    this.catalog = deps.catalog;
    this.catalogTimeMs = deps.catalogTimeMs ?? CATALOG_TIME_MS;
    this.clock = deps.clock ?? Date.now;
  }

  async recognize(request: RecognitionRequest): Promise<RecognizedItem[]> {
    checkPhotoCount(request);
    const startedAt = this.clock();
    switch (request.mode) {
      case "single": return this.withCatalog([await this.single(request.photos)], startedAt);
      case "multi": return this.withCatalog(await this.multi(request.photos), startedAt);
      case "sealed": return [await this.product(request.photos, "sealed")];
      case "bulk": return [await this.product(request.photos, "bulk")];
    }
  }

  /**
   * After the reading: each card is looked up in the catalog, one at a time,
   * in the `background` line and within one budget for the whole scan. The
   * catalog never fails a scan: any trouble leaves the reading as it is and
   * the card marked "not checked". Fields are not changed here; the scan
   * applies a sure card by the filling rule when it files the item.
   */
  private async withCatalog(cards: ReadCard[], startedAt: number): Promise<RecognizedItem[]> {
    const catalog = this.catalog;
    if (!catalog) return cards.map((c) => c.item);
    const scan = createScanBudget();
    const deadline = Math.min(this.clock() + this.catalogTimeMs, startedAt + CATALOG_LATEST_MS);
    let late = false;
    const gate = stoppable(catalog);
    for (const { item, names, yearFromStats } of cards) {
      if (item.kind !== "card" || (names.length === 0 && !item.cardNumber)) continue;
      if (scan.stopped) {
        item.catalog = { status: "not_checked", reason: scan.stopped };
        continue;
      }
      const left = deadline - this.clock();
      if (late || left <= 0) {
        item.catalog = { status: "not_checked", reason: "time" };
        continue;
      }
      if (scan.used >= scan.max) {
        item.catalog = { status: "not_checked", reason: "budget" };
        continue;
      }
      try {
        const result = await within(lookupCard({
          year: item.year, yearFromStats, brands: item.brand ? [item.brand] : [], sport: item.sport, names, cardNumber: item.cardNumber,
        }, "background", { catalog: gate, scan }), left);
        if (result === TIMED_OUT) {
          late = true;
          gate.stop();
          item.catalog = { status: "not_checked", reason: "time" };
        } else {
          item.catalog = catalogPart(result, item.confidence);
        }
      } catch {
        item.catalog = { status: "not_checked", reason: "failed" };
      }
    }
    return cards.map((c) => c.item);
  }

  private async read(image: Buffer, options?: ReadOptions): Promise<OcrResult | null> {
    try {
      return await this.reader.read(image, options);
    } catch {
      return null;
    }
  }

  private async single(photos: RecognitionPhoto[]): Promise<ReadCard> {
    const front = photos.find((p) => p.role === "front") ?? photos[0];
    const back = photos.find((p) => p.role === "back");
    const frontText = await this.read(front.data);
    const backText = back ? await this.read(back.data, { back: true }) : null;
    return this.cardFromText(frontText, backText, { sourceIndex: 0, box: null });
  }

  private async multi(photos: RecognitionPhoto[]): Promise<ReadCard[]> {
    const out: ReadCard[] = [];
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
          // Many cards per photo: quick reads keep a big sheet inside the time limit.
          text = await this.read(await this.straighten(await cropPhoto(photo, box)), { quick: true });
        } catch {
          text = null;
        }
        out.push(await this.cardFromText(text, null, { sourceIndex: index, box }));
      }
    }
    return out;
  }

  /** Turns a tilted card crop upright so the text runs straight. */
  private async straighten(crop: Buffer): Promise<Buffer> {
    try {
      const tilt = await this.tilt(crop);
      if (!Number.isFinite(tilt) || Math.abs(tilt) < MIN_STRAIGHTEN_DEG) return crop;
      return await sharp(crop).rotate(-tilt, { background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    } catch {
      return crop;
    }
  }

  private async findPlayer(parsed: ParsedCard): Promise<{ facts: PlayerFacts; read: string } | null> {
    // Only the read player, in the forms the card shows: Wikidata never picks
    // another name for the card.
    if (!parsed.player) return null;
    for (const name of parsed.playerCandidates.slice(0, MAX_LOOKUPS_PER_CARD)) {
      try {
        const facts = await this.lookup(name, { sport: parsed.sport, year: parsed.year });
        if (facts) return { facts, read: name };
      } catch {
        // Wikidata is a bonus. A failed lookup never fails a scan.
      }
    }
    return null;
  }

  /** Wikidata facts for a known player name; null on any trouble. */
  private async factsFor(name: string, parsed: ParsedCard): Promise<PlayerFacts | null> {
    try {
      return await this.lookup(name, { sport: parsed.sport, year: parsed.year });
    } catch {
      return null;
    }
  }

  private async cardFromText(
    front: OcrResult | null,
    back: OcrResult | null,
    where: { sourceIndex: number; box: Box | null },
  ): Promise<ReadCard> {
    const parsed = parseCardText(front, back);
    const readAnything = parsed.year != null || parsed.brand != null || parsed.cardNumber != null || parsed.player != null;
    if (!readAnything) {
      const notes = back ? UNREAD_NOTE : `${UNREAD_NOTE} ${ADD_BACK_NOTE}`;
      return { item: recognizedItemSchema.parse({ kind: "card", confidence: 0.05, ...where, notes }), names: [] };
    }

    // 1. The built-in key card list. A match counts only when what was read agrees with it.
    const match = matchKeyCard({
      year: parsed.year,
      brand: parsed.brand,
      setName: parsed.setName,
      cardNumber: parsed.cardNumber,
      players: parsed.playerCandidates,
      sport: parsed.sport,
    });
    const key: KeyCard | null = match?.how === "confirmed" ? match.card : null;

    // 2. Wikidata, to confirm the player and fill in the sport.
    const found = key ? null : await this.findPlayer(parsed);
    const facts = found?.facts ?? null;

    const notes = [...parsed.evidence];
    // 3. A team hint (not sure from the text alone) is written only when the
    // player's team list on Wikidata has it. A key card skipped step 2, so its
    // player is looked up here, and only when there is a hint to check.
    let team = parsed.team;
    if (!team && parsed.teamHint) {
      const teamFacts = facts ?? (key ? await this.factsFor(key.player, parsed) : null);
      const confirmed = teamFacts ? teamFromList(parsed.teamHint, parsed.teamHintSport, teamFacts.sports, teamFacts.teams) : null;
      if (confirmed) {
        team = confirmed;
        notes.push(`Team confirmed on Wikidata: ${confirmed}.`);
      }
    }
    // Values read from the card always win; the list and Wikidata only fill gaps.
    const readPlayer = parsed.player;
    let player = readPlayer;
    if (key) player = key.player;
    else if (facts && readPlayer && normalizeName(facts.name) === normalizeName(readPlayer)) player = facts.name;
    const setIsJustBrand = !parsed.setName || (parsed.brand != null && normalizeBrand(parsed.setName) === normalizeBrand(parsed.brand));

    const item: RecognizedItemInput = {
      kind: "card",
      confidence: 0,
      ...where,
      sport: parsed.sport ?? key?.sport ?? facts?.sports[0] ?? null,
      year: parsed.year,
      brand: parsed.brand,
      setName: key && setIsJustBrand ? key.setName : parsed.setName,
      cardNumber: key ? key.cardNumber : parsed.cardNumber,
      player,
      team,
      variation: null,
      isRookie: key?.isRookie ?? false,
      isError: false,
      // A read serial number is only a suggestion: it travels in `evidence`, never as a field.
      serialNumber: null,
      isAutograph: parsed.isAutograph,
      grader: parsed.grader,
      grade: parsed.grade,
      certNumber: parsed.certNumber,
      rarityTier: key?.tier ?? (facts?.hallOfFame ? "star" : null),
      rarityNotes: key?.note ?? null,
      estimate: null,
    };

    // A listed error or variation is never assumed: most copies are the plain card.
    let errorCheck = match?.how === "confirmed" ? match.errorCheck : null;
    if (errorCheck && key && ruledOutOnFront(errorCheck, key, front)) errorCheck = null;
    if (key && errorCheck) {
      notes.push(`Check whether this is the error version: ${errorCheck.variation ?? "error"}. ${errorCheck.note}`);
      if (errorCheck === key) {
        // The list entry describes the error itself, so its rarity is not this copy's.
        item.rarityTier = null;
        item.rarityNotes = null;
      }
    }

    if (key) {
      notes.push("Matched a card on the built-in list of key cards.");
    } else if (match) {
      const what = match.card.cardNumber && !parsed.cardNumber ? "The card number was not read" : "The player name was not read";
      notes.push(`Possible match: ${formatKeyCard(match.card)}. ${what}, so check it.`);
    }
    if (!key && facts) {
      notes.push(`Player confirmed on Wikidata: ${facts.name}${facts.description ? `, ${facts.description}` : ""}.`);
      if (facts.hallOfFame) item.rarityNotes = "Hall of Fame player. Cards of Hall of Famers usually sell for more.";
      const year = item.year;
      if (year != null && facts.careerStart != null && year - facts.careerStart >= 0 && year - facts.careerStart <= 1) {
        const hint = "The card year matches this player's first seasons, so it may be a rookie card. Check before relying on it.";
        item.rarityNotes = item.rarityNotes ? `${item.rarityNotes} ${hint}` : hint;
      }
    }

    const textConfidence = Math.max(front?.confidence ?? 0, back?.confidence ?? 0);
    const weak = textConfidence < 0.5 || item.year == null || item.cardNumber == null;
    if (!back && weak) notes.push(ADD_BACK_NOTE);
    notes.push(FREE_NOTE);
    item.notes = notes.join(" ").slice(0, 600);

    // Confidence comes from how much was read and confirmed, then is held
    // back when the text itself was hard to read.
    let confidence: number;
    if (key) {
      confidence = KEY_CONFIDENCE;
      if (errorCheck) confidence = Math.min(confidence, CHECK_CONFIDENCE);
    } else {
      // Each field counts by how many independent signs on the card agree
      // (12R.4): a year printed on the front, the copyright year and the stat
      // table; a logo on the front, on the back and the copyright line; the
      // name on both sides. Clean reads can then be filed on their own later,
      // unsure ones wait for the owner.
      const more = (signs: number) => 0.05 * Math.min(2, Math.max(0, signs - 1));
      confidence = 0.05;
      if (item.year != null) confidence += 0.15 + (item.year === parsed.year ? more(parsed.yearSigns) : 0);
      if (item.brand) confidence += 0.15 + (item.brand === parsed.brand ? more(parsed.brandSigns) : 0);
      if (item.cardNumber) confidence += 0.15;
      if (item.player) confidence += 0.1 + (parsed.playerAgree ? 0.05 : 0);
      if (facts) confidence += 0.15;
      // Without a key card the best is 0.8, and only with year, brand and number read:
      // Wikidata knowing the player does not say which card this is.
      confidence = Math.min(confidence, MAX_WITHOUT_KEY);
      if (!(item.year != null && item.brand && item.cardNumber)) confidence = Math.min(confidence, CHECK_CONFIDENCE);
      if (match) confidence = Math.min(confidence, CHECK_CONFIDENCE);
    }
    // Certainty per field: the parser's, except where the key card list put
    // in a value the card did not show (then it is not the card's own sign).
    const certainty: FieldCertainty = {};
    for (const f of CERTAIN_FIELDS) {
      const value = item[f];
      if (value == null || value === "") continue;
      const read = parsed[f];
      certainty[f] = (read != null && String(read) === String(value)) || (f === "player" && readPlayer != null && normalizeName(String(value)) === normalizeName(readPlayer))
        ? (parsed.certainty[f] ?? "unsure")
        : "unsure";
    }
    // Only a card whose player, year and brand are all sure may be filed
    // without the owner (12R.5 round 2): anything else waits in Review.
    if (!(certainty.player === "sure" && certainty.year === "sure" && certainty.brand === "sure")) {
      confidence = Math.min(confidence, CHECK_CONFIDENCE);
    }
    if (textConfidence < 0.5) confidence = Math.min(confidence, 0.6);
    // A reprint is never the valuable original: always let the owner check it.
    if (parsed.isReprint) {
      confidence = Math.min(confidence, 0.6);
      item.rarityTier = null;
      item.rarityNotes = "Marked REPRINT: a later copy, usually worth far less than the original card.";
    }
    item.confidence = Math.min(0.95, confidence);
    const names: string[] = [];
    for (const n of [player, ...parsed.playerCandidates]) if (n && !names.includes(n)) names.push(n);
    const evidence: ReadEvidence = {};
    if (Object.keys(certainty).length > 0) evidence.certainty = certainty;
    // The key list hit is passed on explicitly; the item layer never guesses it from the reader's name.
    if (key) evidence.keyCard = { isRookie: key.isRookie };
    if (parsed.isReprint) evidence.reprint = true;
    if (parsed.rookieWord) evidence.rookieWord = true;
    if (parsed.serialRead) {
      const { text, line, weak, why } = parsed.serialRead;
      evidence.serial = { text, line, weak, why };
    }
    const done: RecognizedItem = recognizedItemSchema.parse(item);
    if (Object.keys(evidence).length > 0) done.evidence = evidence;
    return { item: done, names: names.slice(0, 5), yearFromStats: parsed.yearFromStats };
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
