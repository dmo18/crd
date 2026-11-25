import sharp from "sharp";
import type { Sport } from "@/db/schema";
import { findCard, type FindResult } from "@/lib/catalog/find";
import { createScanBudget } from "@/lib/catalog/lookup";
import type { Catalog } from "@/lib/catalog/types";
import { errorKind, log } from "@/lib/log";
import { endSentence } from "@/lib/title";
import { checkPhotoCount } from "@/lib/recognition/limits";
import {
  CERTAIN_FIELDS,
  FRONT_TWICE,
  RecognitionError,
  recognizedItemSchema,
  type FieldCertainty,
  type HoldReason,
  type Box,
  type RecognitionPhoto,
  type RecognitionRequest,
  type PhotoFix,
  type ReadEvidence,
  type RecognizedItem,
  type RecognizedCatalog,
  type RecognizedItemInput,
  type Recognizer,
} from "@/lib/recognition/types";
import { cardTilt, findCardShapes, type CardShape } from "./find-cards";
import { keyCardsFor, matchKeyCard, normalizeBrand, normalizeName, type KeyCard } from "./key-cards";
import { getTextReader, ReaderDownError, type OcrResult, type ReadOptions, type TextReader } from "./ocr";
import { parseCardText, parseProductText, teamFromList, type ParsedCard } from "./parse";
import { lookupPlayer, type PlayerFacts } from "./wikidata";
import { frontTwice, looksLikeBack, ONE_SIDE_NOTE, pairSides, repeatedSides, type SideRead } from "./multi";
import { CUT_BLANK, cutOutCard, maskCard, untilt, type CardCut } from "./cut-out";

/** The details a back's read gives on its own. */
const BACK_FIELDS = ["year", "brand", "setName", "cardNumber", "player", "team", "sport"] as const;

/** A second read of a back is better: every detail the first gave, the same, and at least one more. */
function betterRead(first: OcrResult | null, again: OcrResult): boolean {
  const a = parseCardText(null, first);
  const b = parseCardText(null, again);
  let more = 0;
  for (const f of BACK_FIELDS) {
    if (a[f] != null && a[f] !== "" && b[f] !== a[f]) return false;
    if ((a[f] == null || a[f] === "") && b[f] != null && b[f] !== "") more++;
  }
  return more > 0;
}

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
  /** Cards in a photo as upright boxes (tests). Left out: the card finder, with each card's own outline. */
  findBoxes?: (image: Buffer) => Promise<Box[]>;
  /** Cards in a photo with their own outlines (tests). Wins over findBoxes. */
  findShapes?: (image: Buffer) => Promise<CardShape[]>;
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

type CropSide = { photo: number; box: Box | null; text: OcrResult | null; cut?: CardCut };

/**
 * Many cards: how each stored cut-out is shown (S1b), with the same rules as
 * a one card photo: the turn, and the card box within the cut-out for the
 * tight cut. `cuts` says how the cut-out itself was made (its outline and
 * tilt), so the stored picture is the very picture that was read. The item's
 * own crop is its front side, or its lone side; a back paired with a front is
 * stored as the card's back (item.backPhoto) and gets its own entry.
 */
function withCropTurns(card: ReadCard, own: CropSide, pairedBack?: CropSide): void {
  const fixes: PhotoFix[] = [];
  const cuts: NonNullable<RecognizedItem["cuts"]> = {};
  const add = (side: CropSide, role: "front" | "back") => {
    if (side.box && side.text?.fix) {
      // Without the cut-out's own record the card box would not fit the stored crop: only the turn then.
      fixes.push({ ...side.text.fix, ...(side.cut ? {} : { card: null, cardTrusted: false }), sourceIndex: side.photo, role });
    }
    if (side.box && side.cut) cuts[role] = side.cut;
  };
  add(own, "front");
  if (pairedBack) add(pairedBack, "back");
  if (fixes.length) card.item.fixes = fixes;
  if (cuts.front || cuts.back) card.item.cuts = cuts;
}

/** A card's short side over its long side lies between these. */
const CARD_ASPECT = [0.5, 0.9] as const;

/** A find that looks like a card: card proportions in the photo's pixels, clear of the photo's edges. */
function cardShaped(box: Box, photo: RecognitionPhoto): boolean {
  const w = box.w * Math.max(1, photo.width);
  const h = box.h * Math.max(1, photo.height);
  const aspect = Math.min(w, h) / Math.max(w, h, 1);
  const edge = box.x <= 0.002 || box.y <= 0.002 || box.x + box.w >= 0.998 || box.y + box.h >= 0.998;
  return !edge && aspect >= CARD_ASPECT[0] && aspect <= CARD_ASPECT[1];
}

/** A cut-out shorter than this on its long side is enlarged before reading, as a one card photo would be read. */
const CUT_READ_EDGE = 1600;
/** At most this many times. */
const CUT_MAX_UP = 3;

/** The cut-out as JPEG for the reader, enlarged when it is small (a card in a photo of several is small). */
async function forReading(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const long = Math.max(meta.width ?? 1, meta.height ?? 1);
  const f = Math.min(CUT_MAX_UP, CUT_READ_EDGE / long);
  const pipe = f > 1.05 ? sharp(png).resize(Math.round((meta.width ?? 1) * f), Math.round((meta.height ?? 1) * f), { fit: "fill", kernel: "lanczos3" }) : sharp(png);
  return pipe.jpeg({ quality: 90 }).toBuffer();
}

/** A card as read, with the name spellings the catalog look up may try. */
type ReadCard = { item: RecognizedItem; names: string[]; yearFromStats?: boolean };

const MAX_CARDS_PER_PHOTO = 30;
const MAX_LOOKUPS_PER_CARD = 2;
/** Cards turned less than this are read as they are. */
const MIN_STRAIGHTEN_DEG = 5;
const FREE_NOTE = "Read with free text recognition. Check the details, then add a value from sold listings.";
/** Shown when the text reader itself is not working: the scan fails, no empty cards. */
export const READER_DOWN = "The text reader is not working. Try again later.";
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
 * The S1a look up's answer as the catalog part of a recognized card: exactly
 * one verified match is linked when the item is filed (status `matched`,
 * the match first); anything else is a list for the owner's tap.
 */
export function findPart(result: FindResult): RecognizedCatalog {
  if (result.match) return { status: "matched", candidates: result.candidates };
  if (result.candidates.length > 0) return { status: "candidates", candidates: result.candidates };
  if (result.stopped) return { status: "not_checked", reason: result.stopped };
  return { status: "none" };
}

/** Fields the set's checklist filled or confirmed (rule D), written on the read card with their certainty. */
export function applyFills(item: RecognizedItem, result: Pick<FindResult, "fills" | "notes">): void {
  if (result.fills.length === 0 && result.notes.length === 0) return;
  const certainty: FieldCertainty = { ...(item.evidence?.certainty ?? {}) };
  const checklist = [...(item.evidence?.checklist ?? [])];
  for (const fill of result.fills) {
    const now = item[fill.field];
    // Only a blank is filled; an equal value is only confirmed. A read value is never replaced.
    if (now != null && now !== "" && String(now) !== fill.value) continue;
    // A blank filled from the set list is the catalog's value, not the card's: it is kept apart (source `checklist`).
    if ((now == null || now === "") && !checklist.includes(fill.field)) checklist.push(fill.field);
    item[fill.field] = fill.value;
    certainty[fill.field] = fill.sure ? "sure" : "unsure";
  }
  item.evidence = { ...(item.evidence ?? {}), certainty, ...(checklist.length > 0 ? { checklist } : {}) };
  if (result.notes.length > 0) item.notes = [item.notes, ...result.notes].filter(Boolean).join(" ").slice(0, 600);
}

function cornersOf(b: Box): [number, number][] {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
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
  private readonly findShapes: (image: Buffer) => Promise<CardShape[]>;
  private readonly lookup: NonNullable<FreeDeps["lookup"]>;
  private readonly tilt: NonNullable<FreeDeps["tilt"]>;
  private readonly catalog: Catalog | undefined;
  private readonly catalogTimeMs: number;
  private readonly clock: () => number;

  constructor(deps: FreeDeps = {}) {
    this.reader = deps.reader ?? getTextReader();
    const findBoxes = deps.findBoxes;
    this.findShapes = deps.findShapes ?? (findBoxes
      ? async (image) => (await findBoxes(image)).map((box) => ({ box, outline: cornersOf(box) }))
      : findCardShapes);
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
        const certainty = item.evidence?.certainty ?? {};
        const result = await within(findCard({
          sport: item.sport, year: item.year, yearFromStats, brand: item.brand, setName: item.setName, cardNumber: item.cardNumber,
          player: item.player ?? names[0] ?? null, team: item.team, variation: item.variation,
          unsure: CERTAIN_FIELDS.filter((f) => item[f] != null && item[f] !== "" && certainty[f] !== "sure"),
          notRead: item.evidence?.notRead ?? [],
        }, "background", { catalog: gate, scan }), left);
        if (result === TIMED_OUT) {
          late = true;
          gate.stop();
          item.catalog = { status: "not_checked", reason: "time" };
        } else {
          applyFills(item, result);
          item.catalog = findPart(result);
        }
      } catch {
        item.catalog = { status: "not_checked", reason: "failed" };
      }
    }
    return cards.map((c) => c.item);
  }

  /**
   * The read text, or null when this photo gave no text. When the reader
   * itself is not working the scan fails with a plain message, so it is not
   * saved as empty cards and the alerts count it.
   */
  private async read(image: Buffer, options?: ReadOptions): Promise<OcrResult | null> {
    try {
      return await this.reader.read(image, options);
    } catch (err) {
      if (err instanceof ReaderDownError) {
        log.warn("text_reader_down", { kind: errorKind(err) });
        throw new RecognitionError(READER_DOWN, { cause: err });
      }
      return null;
    }
  }

  private async single(photos: RecognitionPhoto[]): Promise<ReadCard> {
    const front = photos.find((p) => p.role === "front") ?? photos[0];
    const back = photos.find((p) => p.role === "back");
    const frontText = await this.read(front.data);
    const backText = back ? await this.read(back.data, { back: true }) : null;
    // The second photo shows the front again: it is no second sign of
    // anything, so the card is read from the front alone, and the owner is
    // told to add the back.
    const twice = frontTwice(frontText, backText);
    const card = await this.cardFromText(frontText, twice ? null : backText, { sourceIndex: 0, box: null }, { frontTwice: twice });
    const fixes: PhotoFix[] = [];
    if (frontText?.fix) fixes.push({ ...frontText.fix, sourceIndex: photos.indexOf(front), role: "front" });
    if (back && backText?.fix) fixes.push({ ...backText.fix, sourceIndex: photos.indexOf(back), role: "back" });
    if (fixes.length) card.item.fixes = fixes;
    return card;
  }

  /**
   * Many cards in one or more photos (12R.7). Each card found is cut out
   * along its own outline (the rest of the photo blanked, so no text of a
   * neighbouring card can reach it), turned upright and read on its own like
   * a single card. A front and a back in different photos are joined into one
   * card when their text shows they are the same card (pairSides); the pair
   * is then read exactly like a single scan with both sides. A side left
   * without its partner, in a scan that has both fronts and backs, waits for
   * the owner with a note; a back alone counts only with a name on it.
   */
  private async multi(photos: RecognitionPhoto[]): Promise<ReadCard[]> {
    const sides: (SideRead & { box: Box | null; cut?: CardCut; asBack?: boolean })[] = [];
    for (const [index, photo] of photos.entries()) {
      let shapes: CardShape[] = [];
      try {
        shapes = (await this.findShapes(photo.data)).slice(0, MAX_CARDS_PER_PHOTO);
      } catch {
        shapes = [];
      }
      if (shapes.length === 0) {
        // No separate cards found: the whole photo is one card, read as a front (as before).
        sides.push({ photo: index, box: null, text: await this.read(photo.data), back: false });
        continue;
      }
      for (const shape of shapes) {
        let text: OcrResult | null = null;
        let back = false;
        let cut: CardCut | undefined;
        try {
          const made = await this.cutOut(photo, shape);
          cut = made.cut;
          text = await this.read(await sharp(made.png).jpeg({ quality: 90 }).toBuffer(), { backIf: (first) => (back = looksLikeBack(first)) });
        } catch (err) {
          if (err instanceof RecognitionError) throw err;
          text = null;
        }
        sides.push({ photo: index, box: shape.box, text, back: back || looksLikeBack(text), cut, asBack: back });
      }
    }

    // Not a card, or a card already seen: a find with no print read on it
    // at all that is not card shaped or lies at the photo's edge (a piece of
    // a notebook or keyboard), and a side photographed again in another
    // photo of the scan (the better photo of it is kept). A find whose read
    // failed stays, as unread.
    const skip = new Set<number>();
    sides.forEach((s, i) => {
      if (s.box === null || s.text === null || s.text.lines.some((l) => (l.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3)) return;
      if (!cardShaped(s.box, photos[s.photo])) skip.add(i);
    });
    const found = sides.map((s, i) => ({ s, i })).filter((x) => x.s.box !== null && !skip.has(x.i));
    for (const [again] of repeatedSides(found.map((x) => x.s))) skip.add(found[again].i);

    // Pairing only among cards found apart; a whole photo read as one card stays alone.
    const apart = sides.map((s, i) => ({ s, i })).filter((x) => x.s.box !== null && !skip.has(x.i));
    const pairs = pairSides(apart.map((x) => x.s)).map(([f, b]) => [apart[f].i, apart[b].i] as const);
    const backOf = new Map(pairs.map(([f, b]) => [f, b]));
    const paired = new Set(pairs.map(([, b]) => b));
    // "Lone" makes sense only when a partner could have been in the scan:
    // fronts and backs found in different photos. A scan of fronts only reads as before.
    const canPair = apart.some((f) => !f.s.back && apart.some((b) => b.s.back && b.s.photo !== f.s.photo));

    // A paired back is read again as a back, enlarged to the size a one card
    // photo is read at (the copyright line and the corners are small in a
    // photo of several cards). The new read is kept only when it gives every
    // detail the first one gave, the same, and more.
    for (const [, b] of pairs) {
      const back = sides[b];
      if (!back.cut) continue;
      try {
        const png = await cutOutCard(photos[back.photo].data, back.cut);
        const again = await this.read(await forReading(png), { back: true });
        if (again && betterRead(back.text, again)) back.text = again;
      } catch (err) {
        if (err instanceof RecognitionError) throw err;
      }
    }

    const out: ReadCard[] = [];
    for (const [i, side] of sides.entries()) {
      if (skip.has(i)) continue;
      const where = { sourceIndex: side.photo, box: side.box };
      if (!side.back) {
        const b = backOf.get(i);
        if (b !== undefined) {
          const back = sides[b];
          const card = await this.cardFromText(side.text, back.text, where);
          if (back.box) card.item.backPhoto = { sourceIndex: back.photo, box: back.box };
          withCropTurns(card, side, back);
          out.push(card);
        } else {
          const card = await this.cardFromText(side.text, null, where, { lone: canPair && side.box !== null });
          withCropTurns(card, side);
          out.push(card);
        }
        continue;
      }
      if (paired.has(i)) continue;
      if (!canPair) {
        // Backs only: each back is a card, read as a back.
        const card = await this.cardFromText(null, side.text, where);
        withCropTurns(card, side);
        card.item.cropSide = "back";
        out.push(card);
        continue;
      }
      // A back without its front becomes a card only with a trustworthy name on it.
      if (parseCardText(null, side.text).player) {
        const card = await this.cardFromText(null, side.text, where, { lone: true });
        withCropTurns(card, side);
        card.item.cropSide = "back";
        out.push(card);
      }
    }
    return out;
  }

  /**
   * One card cut out of a photo along its own outline and turned straight
   * (cut-out.ts), with the record of how, so the stored picture is the same.
   */
  private async cutOut(photo: RecognitionPhoto, shape: CardShape): Promise<{ png: Buffer; cut: CardCut }> {
    const masked = await maskCard(photo.data, shape.box, shape.outline);
    let tilt = 0;
    try {
      const t = await this.tilt(masked);
      if (Number.isFinite(t) && Math.abs(t) >= MIN_STRAIGHTEN_DEG) tilt = t;
    } catch {
      tilt = 0;
    }
    const cut: CardCut = { box: shape.box, outline: shape.outline, tilt };
    return { png: await untilt(masked, tilt, CUT_BLANK), cut };
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

  /**
   * `lone`: one side of a card from a many-card scan that also had the other
   * sides, left without its partner. It says so in the notes and always
   * waits for the owner.
   */
  private async cardFromText(
    front: OcrResult | null,
    back: OcrResult | null,
    where: { sourceIndex: number; box: Box | null },
    opts: { lone?: boolean; frontTwice?: boolean } = {},
  ): Promise<ReadCard> {
    const parsed = parseCardText(front, back);
    const readAnything = parsed.year != null || parsed.brand != null || parsed.cardNumber != null || parsed.player != null;
    if (!readAnything) {
      const notes = opts.frontTwice ? `${FRONT_TWICE} ${UNREAD_NOTE}` : opts.lone ? `${ONE_SIDE_NOTE} ${UNREAD_NOTE}` : back ? UNREAD_NOTE : `${UNREAD_NOTE} ${ADD_BACK_NOTE}`;
      const item: RecognizedItem = recognizedItemSchema.parse({ kind: "card", confidence: 0.05, ...where, notes });
      if (opts.frontTwice) item.evidence = { hold: ["front_twice"] };
      return { item, names: [] };
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

    const notes = opts.frontTwice ? [FRONT_TWICE, ...parsed.evidence] : opts.lone ? [ONE_SIDE_NOTE, ...parsed.evidence] : [...parsed.evidence];
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
      notes.push(endSentence(`Player confirmed on Wikidata: ${facts.name}${facts.description ? `, ${facts.description}` : ""}`));
      if (facts.hallOfFame) item.rarityNotes = "Hall of Fame player. Cards of Hall of Famers usually sell for more.";
      const year = item.year;
      if (year != null && facts.careerStart != null && year - facts.careerStart >= 0 && year - facts.careerStart <= 1) {
        const hint = "The card year matches this player's first seasons, so it may be a rookie card. Check before relying on it.";
        item.rarityNotes = item.rarityNotes ? `${item.rarityNotes} ${hint}` : hint;
      }
    }

    const textConfidence = Math.max(front?.confidence ?? 0, back?.confidence ?? 0);
    const weak = textConfidence < 0.5 || item.year == null || item.cardNumber == null;
    if (!back && weak && !opts.lone && !opts.frontTwice) notes.push(ADD_BACK_NOTE);
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
    if (opts.lone || opts.frontTwice) confidence = Math.min(confidence, CHECK_CONFIDENCE);
    // A reprint is never the valuable original: always let the owner check it.
    if (parsed.isReprint) {
      confidence = Math.min(confidence, 0.6);
      item.rarityTier = null;
      item.rarityNotes = "Marked REPRINT: a later copy, usually worth far less than the original card.";
    }
    item.confidence = Math.min(0.95, confidence);
    // The hold backs above that no catalog link may lift (S1a rule C keeps them).
    const hold: HoldReason[] = [];
    if (parsed.isReprint) hold.push("reprint");
    if (opts.lone) hold.push("one_side");
    if (opts.frontTwice) hold.push("front_twice");
    if (textConfidence < 0.5) hold.push("hard_to_read");
    if (errorCheck) hold.push("error_check");
    if (!key && match) hold.push("key_list_guess");
    // Filled fields the card itself did not give (the key card list or Wikidata).
    const notRead = CERTAIN_FIELDS.filter((f) => {
      const value = item[f];
      if (value == null || value === "") return false;
      if (f === "player") return readPlayer == null || normalizeName(String(value)) !== normalizeName(readPlayer);
      if (f === "team") return value !== parsed.team;
      const read = parsed[f];
      return read == null || String(read) !== String(value);
    });
    const names: string[] = [];
    for (const n of [player, ...parsed.playerCandidates]) if (n && !names.includes(n)) names.push(n);
    const evidence: ReadEvidence = {};
    if (Object.keys(certainty).length > 0) evidence.certainty = certainty;
    // The key list hit is passed on explicitly; the item layer never guesses it from the reader's name.
    if (key) evidence.keyCard = { isRookie: key.isRookie };
    if (parsed.isReprint) evidence.reprint = true;
    if (hold.length > 0) evidence.hold = hold;
    if (notRead.length > 0) evidence.notRead = notRead;
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
