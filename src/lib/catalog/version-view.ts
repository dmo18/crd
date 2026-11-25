import type { Item } from "@/db/schema";
import { parseCatalog } from "./candidates";
import { sourceUrl } from "./clean";
import { hasSeveralVersions, parseVersions, type CatalogStatus } from "./versions";

/** What the "Which version is it?" block shows, as plain data for the screen. */
export type VersionView = {
  /** "Version: Tiffany, you chose it, from MyCardfolio" or "Version: not chosen". */
  stateLine: string;
  several: boolean;
  /** The app linked the normal card by itself and the question is open: the normal card is preselected, not the owner's answer. */
  assumed: boolean;
  list: null | {
    at: number;
    /** One plain line when the catalog gave nothing (off, paused, busy, ...). Null when it answered. */
    catalogLine: string | null;
    options: { position: number; kind: "base" | "version" | "another" | "not_sure"; name: string; evidence: { text: string; url: string | null }[] }[];
  };
};

const SOURCE_WORDS = {
  catalog: "you chose it, from MyCardfolio",
  known_list: "you chose it, from the known versions list",
  owner: "you chose it",
} as const;

export const CATALOG_LINES: Record<Exclude<CatalogStatus, "ok">, string> = {
  none: "The catalog had nothing more for this card. These choices are from the known list.",
  not_asked: "Add the year, brand and player to ask the catalog. These choices are from the known list.",
  off: "The card catalog is switched off. These choices are from the known list.",
  paused: "The card catalog asked us to slow down. These choices are from the known list.",
  cap: "The limit of catalog calls was used up. These choices are from the known list.",
  busy: "The catalog was busy. These choices are from the known list.",
  failed: "The catalog did not answer properly. These choices are from the known list.",
};

export const ASSUMED_LINE = "Assumed the normal version. Tap to change.";

export function stateLine(item: Pick<Item, "versionState" | "versionSource" | "variation">, assumed = false): string {
  if (assumed) return ASSUMED_LINE;
  if (item.versionState === "not_sure") return "Version: not sure yet";
  if (item.versionState === "confirmed") {
    const what = item.variation?.trim() || "the normal card";
    return `Version: ${what}, ${item.versionSource ? SOURCE_WORDS[item.versionSource] : "you chose it"}`;
  }
  return "Version: not chosen";
}

export function versionView(item: Item, now: Date = new Date()): VersionView {
  const stored = parseVersions(item.versionOptions, now);
  const candidates = item.catalogCardId == null ? parseCatalog(item.catalogCandidates, now) : null;
  // Assumed only while nothing was chosen, nothing is typed as a version and the card is still linked.
  const assumed = stored?.assumed === true && item.versionState == null && !item.variation?.trim() && item.catalogCardId != null;
  return {
    assumed,
    stateLine: stateLine(item, assumed),
    several: hasSeveralVersions(candidates?.items ?? []),
    list: stored ? {
      at: stored.at,
      catalogLine: stored.catalog === "ok" ? null : CATALOG_LINES[stored.catalog],
      options: stored.options.map((o, position) => ({
        position, kind: o.kind, name: o.name,
        evidence: o.evidence.map((e) => ({ text: e.text, url: sourceUrl(e.url) })),
      })),
    } : null,
  };
}
