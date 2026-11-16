import type { Sport } from "@/db/schema";
import { normalizeBrand } from "./normalize";

/**
 * The known versions list (PLAN Milestone 11, "Which version is it", source 2).
 * A short table written by hand for the years of the owner's cards. A row is
 * offered as a choice when the brand (or set) and the year fit. It is never a
 * claim that the card is that version, and nothing is chosen from it.
 *
 * Every row has a source note. The facts are the common hobby knowledge found
 * in the standard price guides (Beckett, the Standard Catalog of Baseball
 * Cards) and the set checklists on the card sites. Where the catalog recordings
 * of task 11.2 confirm a row (docs/CATALOG-TRIAL.md, "Version recordings"),
 * the note says so.
 */

export type KnownVersion = {
  /** Stable id, kept in stored options. */
  id: string;
  /** The name of the version as the owner sees it and as it is written in `variation`. */
  name: string;
  /** Brand or line names it belongs to, compared with normalizeBrand. */
  brands: readonly string[];
  from: number;
  to: number;
  /** Only for these sports, when set. */
  sports?: readonly Sport[];
  /** One line on how to tell it apart from the normal card. */
  howToTell: string;
  /** Where the facts come from. Not shown on the screens. */
  source: string;
};

export const KNOWN_VERSIONS: readonly KnownVersion[] = [
  {
    id: "topps-tiffany", name: "Tiffany", brands: ["Topps"], from: 1984, to: 1991, sports: ["baseball"],
    howToTell: "glossy front, bright white back, sold only as a boxed set",
    source: "Price guides list Topps Tiffany sets for 1984 to 1991. Recordings: 1990 Topps #414 Thomas, 1991 Topps #333 Jones.",
  },
  {
    id: "bowman-tiffany", name: "Tiffany", brands: ["Bowman"], from: 1989, to: 1990, sports: ["baseball"],
    howToTell: "glossy front, bright white back, sold only as a boxed set",
    source: "Price guides list Bowman Tiffany sets for 1989 and 1990.",
  },
  {
    id: "fleer-glossy", name: "Glossy", brands: ["Fleer"], from: 1987, to: 1989, sports: ["baseball"],
    howToTell: "glossy front, sold only as a boxed set in a tin",
    source: "Price guides list Fleer Glossy (tin) sets for 1987 to 1989. Recordings: 1987 Fleer #604 Bonds, 1989 Fleer #616 Ripken.",
  },
  {
    id: "topps-desert-shield", name: "Desert Shield", brands: ["Topps"], from: 1991, to: 1991, sports: ["baseball"],
    howToTell: "gold foil shield stamp on the front",
    source: "Price guides list 1991 Topps Desert Shield, sent to soldiers in the Gulf. Recording: 1991 Topps #333 Jones.",
  },
  {
    id: "topps-gold", name: "Gold", brands: ["Topps"], from: 1992, to: 1994,
    howToTell: "gold foil in place of the printed name and team box",
    source: "Price guides list Topps Gold parallels for 1992 to 1994. Recording: 1992 Topps #1 Ryan.",
  },
  {
    id: "ud-electric-diamond", name: "Electric Diamond", brands: ["Upper Deck"], from: 1994, to: 1994, sports: ["baseball"],
    howToTell: "Electric Diamond foil logo on the front",
    source: "Price guides list 1994 Upper Deck Electric Diamond. Recording: 1994 Upper Deck #24 Rodriguez.",
  },
  {
    id: "score-gold-rush", name: "Gold Rush", brands: ["Score"], from: 1994, to: 1994, sports: ["baseball"],
    howToTell: "gold foil border on the front",
    source: "Price guides list 1994 Score Gold Rush, one per pack.",
  },
  {
    id: "cc-silver-signature", name: "Silver Signature", brands: ["Collector's Choice"], from: 1994, to: 1995,
    howToTell: "silver foil signature on the front",
    source: "Price guides list Collector's Choice (Upper Deck) Silver Signature for 1994 and 1995.",
  },
  {
    id: "cc-gold-signature", name: "Gold Signature", brands: ["Collector's Choice"], from: 1994, to: 1995,
    howToTell: "gold foil signature on the front, much scarcer than silver",
    source: "Price guides list Collector's Choice (Upper Deck) Gold Signature for 1994 and 1995.",
  },
  {
    id: "ultra-gold-medallion", name: "Gold Medallion", brands: ["Ultra", "Fleer Ultra"], from: 1995, to: 1995,
    howToTell: "gold foil medallion on the front",
    source: "Price guides list 1995 Fleer Ultra Gold Medallion, one per pack.",
  },
  {
    id: "stadium-club-first-day", name: "First Day Issue", brands: ["Stadium Club"], from: 1993, to: 1994, sports: ["baseball"],
    howToTell: "First Day Issue foil stamp on the front",
    source: "Price guides list Topps Stadium Club First Day Issue for 1993 and 1994.",
  },
  {
    id: "opc", name: "O-Pee-Chee", brands: ["Topps"], from: 1980, to: 1992, sports: ["baseball", "hockey"],
    howToTell: "Canadian printing: O-Pee-Chee on the back, often in English and French",
    source: "Price guides list O-Pee-Chee baseball and hockey sets printed in Canada from Topps designs.",
  },
];

/**
 * The rows that fit an item: the brand names the row's brand, the year is in
 * its range, and the sport fits when the row is for some sports only (an item
 * without a sport is offered every row that fits otherwise). When the set name
 * is itself a line of the list ("Upper Deck" with set "Collector's Choice",
 * "Topps" with set "Stadium Club"), only that line's rows fit, not the brand's.
 */
export function knownVersionsFor(item: { brand: string | null; setName: string | null; year: number | null; sport: Sport | null }): KnownVersion[] {
  if (item.year == null) return [];
  const year = item.year;
  const setKey = item.setName?.trim() ? normalizeBrand(item.setName) : "";
  const brandKey = item.brand?.trim() ? normalizeBrand(item.brand) : "";
  const setIsLine = setKey !== "" && KNOWN_VERSIONS.some((row) => row.brands.some((b) => normalizeBrand(b) === setKey));
  const key = setIsLine ? setKey : brandKey;
  if (!key) return [];
  return KNOWN_VERSIONS.filter((row) =>
    year >= row.from && year <= row.to &&
    (!row.sports || !item.sport || row.sports.includes(item.sport)) &&
    row.brands.some((b) => normalizeBrand(b) === key));
}
