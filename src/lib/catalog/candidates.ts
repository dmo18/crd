import { z } from "zod";
import { SPORTS } from "@/db/schema";
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

/** Why the catalog was not checked for an item. `budget`: the scan's call budget or time ran out. */
export type NotCheckedReason = CatalogFailure | "budget";
export const NOT_CHECKED_REASONS = ["off", "paused", "cap", "busy", "failed", "budget"] as const satisfies readonly NotCheckedReason[];

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
  score: z.number().finite().catch(0),
  why: z.string().max(200).catch(""),
});
export type StoredCandidate = z.infer<typeof storedCandidateSchema>;

const storedSchema = z.object({
  v: z.literal(1),
  /** Time of the look up in milliseconds. */
  at: z.number().int(),
  status: z.enum(["candidates", "none", "not_checked"]),
  reason: z.enum(NOT_CHECKED_REASONS).nullable().catch(null),
  items: z.array(z.unknown()).max(MAX_STORED_CANDIDATES),
});

export type StoredCatalog = {
  at: number;
  status: "candidates" | "none" | "not_checked";
  reason: NotCheckedReason | null;
  items: StoredCandidate[];
};

/** The slim copy of one candidate that is kept on the item. */
export function slimCandidate(c: Candidate | CatalogCard): StoredCandidate {
  const cut = (v: string | null, max: number) => (v == null ? null : v.slice(0, max));
  return {
    source: c.source, sourceId: c.sourceId, url: c.url.slice(0, 400), sourceSetId: c.sourceSetId, verified: c.verified,
    sport: c.sport, year: c.year, brand: cut(c.brand, 80), setName: cut(c.setName, 120), cardNumber: cut(c.cardNumber, 30),
    player: cut(c.player, 120), variation: cut(c.variation, 120),
    score: "score" in c && Number.isFinite(c.score) ? c.score : 0, why: "why" in c ? String(c.why).slice(0, 200) : "",
  };
}

/** JSON for `items.catalogCandidates`. Candidates that do not pass the shape check are left out. */
export function serializeCatalog(v: { status: StoredCatalog["status"]; reason?: NotCheckedReason | null; items?: (Candidate | CatalogCard)[] }, at: Date): string {
  const items = (v.items ?? [])
    .map(slimCandidate)
    .filter((c) => storedCandidateSchema.safeParse(c).success)
    .slice(0, MAX_STORED_CANDIDATES);
  const status = v.status === "candidates" && items.length === 0 ? "none" : v.status;
  return JSON.stringify({ v: 1, at: at.getTime(), status, reason: status === "not_checked" ? v.reason ?? "failed" : null, items });
}

/** Reads what is stored. Null when there is nothing, it cannot be read, or it is older than 30 days. */
export function parseCatalog(raw: string | null | undefined, now: Date = new Date()): StoredCatalog | null {
  if (!raw) return null;
  try {
    const r = storedSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    if (now.getTime() - r.data.at > CANDIDATE_DAYS * 24 * 60 * 60 * 1000) return null;
    const items: StoredCandidate[] = [];
    for (const it of r.data.items) {
      const c = storedCandidateSchema.safeParse(it);
      if (c.success) items.push(c.data);
    }
    const status = r.data.status === "candidates" && items.length === 0 ? "none" : r.data.status;
    return { at: r.data.at, status, reason: status === "not_checked" ? r.data.reason ?? "failed" : null, items: status === "candidates" ? items : [] };
  } catch {
    return null;
  }
}

/** A stored candidate as a catalog card, for saving it once the owner picked it. */
export function candidateCard(c: StoredCandidate): CatalogCard {
  return {
    source: c.source, sourceId: c.sourceId, url: c.url, sourceSetId: c.sourceSetId, verified: c.verified,
    sport: c.sport, year: c.year, brand: c.brand, setName: c.setName, cardNumber: c.cardNumber, player: c.player,
    otherPlayers: [], variation: c.variation, tags: [],
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
};
