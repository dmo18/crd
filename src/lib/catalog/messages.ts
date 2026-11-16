import type { CatalogFailure } from "./types";

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

/** Plain words for every state the shared gate can answer with. */
export const FAILURE_MESSAGES: Record<CatalogFailure, string> = {
  off: "The card catalog is switched off. You can still add a card by hand.",
  paused: "The card catalog is resting for a little while because it asked us to slow down. Try again later, or add the card by hand.",
  cap: "The limit of catalog calls for now is used up. Try again later, or add the card by hand.",
  busy: "The catalog is busy. Try again in a moment.",
  failed: "The catalog did not answer properly. Try again, or add the card by hand.",
};

