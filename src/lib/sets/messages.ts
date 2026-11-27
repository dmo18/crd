import type { CatalogFailure } from "@/lib/catalog/types";

/** The set page's plain words. */
export const NOT_IN_CATALOG = "The free catalog does not have this set. You can still see what you own.";
export const MAY_BE_INCOMPLETE = "This checklist may be incomplete";

/** Why a checklist load stopped, and that a new tap goes on from there. */
export function stoppedLine(reason: CatalogFailure): string {
  switch (reason) {
    case "cap":
      return "The hourly or daily limit of catalog calls is reached, so loading the checklist paused. Tap Get the checklist again later. It goes on from where it stopped.";
    case "paused":
      return "The catalog asked the app to slow down, so loading the checklist paused. Tap Get the checklist again later. It goes on from where it stopped.";
    case "off":
      return "The card catalog is switched off (More, Connections). Switch it on to get the checklist.";
    case "busy":
      return "The catalog was busy. Tap Get the checklist again in a moment.";
    default:
      return "The catalog did not answer properly. Tap Get the checklist again later.";
  }
}

const FAILURES = ["off", "paused", "cap", "busy", "failed"] as const;
export function asFailure(v: string | null | undefined): CatalogFailure | null {
  return (FAILURES as readonly string[]).includes(v ?? "") ? (v as CatalogFailure) : null;
}
