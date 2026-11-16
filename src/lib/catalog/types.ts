import type { Sport } from "@/db/schema";

/**
 * The one catalog interface. Everything outside this folder talks to a
 * `Catalog`, so MyCardfolio can be swapped for another source later.
 * Design: docs/PLAN.md, Milestone 10, "MyCardfolio client".
 */

export type CatalogCard = {
  source: "mycardfolio";
  sourceId: string;
  /** The card's page on the source; shown as "From MyCardfolio". */
  url: string;
  sourceSetId: string | null;
  /** True for a clean entry (the id is all digits). */
  verified: boolean;
  sport: Sport | null;
  year: number | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  player: string | null;
  otherPlayers: string[];
  variation: string | null;
  /** "RC", "IR", "TC" and the like, taken off the name. Kept for Milestone 11. */
  tags: string[];
};

export type CatalogFailure = "off" | "paused" | "cap" | "busy" | "failed";

export type CatalogResult<T> = { ok: true; value: T; fromStore: boolean } | { ok: false; reason: CatalogFailure };

export type Line = "now" | "background";

export interface Catalog {
  search(q: { text: string; sport?: Sport; year?: number; limit?: number }, line: Line): Promise<CatalogResult<CatalogCard[]>>;
  card(sourceId: string, line: Line): Promise<CatalogResult<CatalogCard | null>>;
  /** At most the first 500 cards: the source cannot page past that (`complete: false` then). */
  checklist(sourceSetId: string, line: Line): Promise<CatalogResult<{ cards: CatalogCard[]; complete: boolean }>>;
}
