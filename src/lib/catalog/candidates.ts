import { z } from "zod";
import { CATALOG_FIELDS, ITEM_STATUSES, SPORTS, VERSION_SOURCES, VERSION_STATES } from "@/db/schema";
import type { Candidate } from "./match";
import type { CatalogCard, CatalogFailure } from "./types";

/**
 * What the last catalog look up left on an item (`items.catalogCandidates`):
 * up to 5 slim candidates for Review, "nothing found", or "not checked" with
 * the reason. Written only by the server from its own catalog answers; the
 * browser only ever sends back a position in this list.
 */

export const MAX_STORED_CANDIDATES = 5;
/** Candidates older than this are not shown any more. */
export const CANDIDATE_DAYS = 30;

/** Why the catalog was not checked for an item. `budget`: the scan's call budget ran out. `time`: the reading used up the time. */
export type NotCheckedReason = CatalogFailure | "budget" | "time";
export const NOT_CHECKED_REASONS = ["off", "paused", "cap", "busy", "failed", "budget", "time"] as const satisfies readonly NotCheckedReason[];

const text = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);

export const storedCandidateSchema = z.object({
  source: z.literal("mycardfolio"),
  sourceId: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
  url: z.string().max(400),
  sourceSetId: z.string().regex(/^\d{1,12}$/).nullable().catch(null),
  verified: z.boolean(),
  sport: z.enum(SPORTS).nullable().catch(null),
  year: z.number().int().min(1800).max(2100).nullable().catch(null),
  brand: text(80),
  setName: text(120),
  cardNumber: text(30),
  player: text(120),
  variation: text(120),
  /** Team and card details text (rookie or variation wording) as the catalog has them. Missing on older lists. */
  team: text(80),
  details: text(120),
  /** How it differs from what the card reads, in plain words ("The catalog says number 67. The card reads 65."). */
  differs: text(200),
  score: z.number().finite().catch(0),
  why: z.string().max(200).catch(""),
});
export type StoredCandidate = z.infer<typeof storedCandidateSchema>;

const storedSchema = z.object({
  v: z.literal(1),
  /** Time of the look up in milliseconds. */
  at: z.number().int(),
  status: z.enum(["candidates", "none", "not_checked", "linked"]),
  reason: z.enum(NOT_CHECKED_REASONS).nullable().catch(null),
  items: z.array(z.unknown()).max(MAX_STORED_CANDIDATES),
  linked: z.unknown().optional(),
});

/**
 * Kept after a link (status `linked`): which row of the list was linked, and
 * whether the app linked it by itself (a verified match), with what the item
 * had before, so Undo can put it back.
 */
const snapshotSchema = z.object({
  status: z.enum(ITEM_STATUSES),
  confidence: z.number().min(0).max(1).nullable(),
  // The rest was added later (review fix 3): older records hold only the status and confidence.
  title: z.string().optional(),
  fieldSources: z.string().nullable().optional(),
  /** The version answer: its state, its source and the stored options. */
  version: z.object({
    state: z.enum(VERSION_STATES).nullable(),
    source: z.enum(VERSION_SOURCES).nullable(),
    options: z.string().nullable(),
  }).optional(),
  /** Only the catalog fields the link changed. */
  fields: z.partialRecord(z.enum(CATALOG_FIELDS), z.union([z.string(), z.number(), z.null()])).optional(),
});
/** What an item held, or what a link wrote on it, for the parts a link changes. */
export type LinkSnapshot = z.infer<typeof snapshotSchema>;

const linkedSchema = z.object({
  position: z.number().int().min(0).max(MAX_STORED_CANDIDATES - 1),
  auto: z.boolean(),
  /** What the item had before the link, so Undo and Unlink put it back. */
  before: snapshotSchema.nullable().catch(null),
  /** What the link wrote: a part the owner changed since then is left as the owner made it. */
  wrote: snapshotSchema.nullable().optional().catch(null),
});
export type LinkedInfo = z.infer<typeof linkedSchema>;

export type StoredCatalog = {
  at: number;
  status: "candidates" | "none" | "not_checked" | "linked";
  reason: NotCheckedReason | null;
  items: StoredCandidate[];
  /** Only with status `linked`. */
  linked: LinkedInfo | null;
};

/** A candidate as kept, plus how it differs from the card's reading. */
export type OfferCandidate = Candidate & { differs?: string | null };

/** The slim copy of one candidate that is kept on the item. */
export function slimCandidate(c: OfferCandidate | CatalogCard | StoredCandidate): StoredCandidate {
  const cut = (v: string | null | undefined, max: number) => (v == null ? null : v.slice(0, max));
  const opt = (v: string | null | undefined, max: number) => (v == null || v.trim() === "" ? null : v.trim().slice(0, max));
  return {
    source: c.source, sourceId: c.sourceId, url: c.url.slice(0, 400), sourceSetId: c.sourceSetId, verified: c.verified,
    sport: c.sport, year: c.year, brand: cut(c.brand, 80), setName: cut(c.setName, 120), cardNumber: cut(c.cardNumber, 30),
    player: cut(c.player, 120), variation: cut(c.variation, 120),
    team: opt("team" in c ? c.team : null, 80), details: opt("details" in c ? c.details : null, 120),
    differs: opt("differs" in c ? c.differs : null, 200),
    score: "score" in c && Number.isFinite(c.score) ? c.score : 0, why: "why" in c ? String(c.why).slice(0, 200) : "",
  };
}

/** JSON for `items.catalogCandidates`. Candidates that do not pass the shape check are left out. */
export function serializeCatalog(
  v: { status: StoredCatalog["status"]; reason?: NotCheckedReason | null; items?: (OfferCandidate | CatalogCard | StoredCandidate)[]; linked?: LinkedInfo | null },
  at: Date,
): string {
  const items = (v.items ?? [])
    .map(slimCandidate)
    .filter((c) => storedCandidateSchema.safeParse(c).success)
    .slice(0, MAX_STORED_CANDIDATES);
  const status = v.status === "candidates" && items.length === 0 ? "none" : v.status;
  const linked = status === "linked" && v.linked ? { linked: v.linked } : {};
  return JSON.stringify({ v: 1, at: at.getTime(), status, reason: status === "not_checked" ? v.reason ?? "failed" : null, items, ...linked });
}

/**
 * Reads what is stored. Null when there is nothing, it cannot be read, or it
 * is older than 30 days. `anyAge`: a link's own record is read at any age
 * (Undo puts back what the item had, however long ago it was linked).
 */
export function parseCatalog(raw: string | null | undefined, now: Date = new Date(), opts: { anyAge?: boolean } = {}): StoredCatalog | null {
  if (!raw) return null;
  try {
    const r = storedSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    const old = now.getTime() - r.data.at > CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
    if (old && !(opts.anyAge && r.data.status === "linked")) return null;
    const items: StoredCandidate[] = [];
    for (const it of r.data.items) {
      const c = storedCandidateSchema.safeParse(it);
      if (c.success) items.push(c.data);
    }
    const status = r.data.status === "candidates" && items.length === 0 ? "none" : r.data.status;
    const linked = status === "linked" ? linkedSchema.safeParse(r.data.linked) : null;
    return {
      at: r.data.at, status, reason: status === "not_checked" ? r.data.reason ?? "failed" : null,
      items: status === "candidates" || status === "linked" ? items : [], linked: linked?.success ? linked.data : null,
    };
  } catch {
    return null;
  }
}

/** A stored candidate as a catalog card, for saving it once the owner picked it. */
export function candidateCard(c: StoredCandidate): CatalogCard {
  return {
    source: c.source, sourceId: c.sourceId, url: c.url, sourceSetId: c.sourceSetId, verified: c.verified,
    sport: c.sport, year: c.year, brand: c.brand, setName: c.setName, cardNumber: c.cardNumber, player: c.player,
    otherPlayers: [], variation: c.variation, tags: [], team: c.team, details: c.details,
  };
}

/** Plain words for Review when the catalog was not checked. */
export const NOT_CHECKED_LINES: Record<NotCheckedReason, string> = {
  off: "The card catalog is switched off.",
  paused: "The card catalog asked us to slow down, so it was skipped for this scan.",
  cap: "The limit of catalog calls was used up, so it was skipped for this scan.",
  busy: "The catalog was busy, so it was skipped for this scan.",
  failed: "The catalog did not answer properly.",
  budget: "This scan had many cards, and the catalog was only checked for the first ones.",
  time: "The catalog was not checked: the reading took too long.",
};
