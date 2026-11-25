"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { items, SPORTS, type Sport } from "@/db/schema";
import { auditThisRequest } from "@/lib/audit/request";
import { requireOwner } from "@/lib/auth/guard";
import { liveItem } from "@/lib/items/live";
import { linkCatalogCard } from "./apply";
import { cardLine } from "./line";
import { getCatalog } from "./provider";
import { addCardToCollection, saveCatalogCard } from "./store";
import { FAILURE_MESSAGES, SEARCH_MAX, SEARCH_MIN } from "./messages";
import type { CatalogCard } from "./types";
import { refreshGuideQuietly } from "@/lib/valuation/guide/apply";

/** One search row as the browser sees it. Add and link take only `sourceId` back. */
export type SearchRow = {
  sourceId: string; line: string; sport: Sport | null; setName: string | null;
  verified: boolean; url: string; shown: [string, string][];
};
export type SearchState = {
  status: "idle" | "done" | "error";
  message: string | null;
  rows: SearchRow[];
  /** What was searched, so the screen can show "Nothing found for ...". */
  asked: string | null;
};
export type AddState = { message: string | null };

const searchSchema = z.object({
  q: z.string().trim().min(SEARCH_MIN, "Type at least 2 letters.").max(SEARCH_MAX, "Keep the words under 80 characters."),
  sport: z.union([z.literal(""), z.enum(SPORTS)]).transform((v) => (v === "" ? undefined : v)),
  year: z.union([z.literal(""), z.string().trim().regex(/^\d{4}$/, "Enter a year like 1990.")])
    .transform((v) => (v === "" ? undefined : Number(v)))
    .refine((v) => v === undefined || (v >= 1860 && v <= 2100), "Enter a year between 1860 and 2100."),
});
const sourceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_]{1,40}$/, "That card could not be found.");
const idSchema = z.coerce.number().int().positive().max(2_000_000_000);

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

function rowOf(c: CatalogCard): SearchRow {
  const shown: [string, string][] = [
    ["Year", c.year == null ? "" : String(c.year)], ["Brand", c.brand ?? ""], ["Set", c.setName ?? "Base set"],
    ["Number", c.cardNumber ?? ""], ["Player", c.player ?? ""], ["Variation", c.variation ?? ""],
    ["Sport", c.sport ?? ""],
  ];
  return {
    sourceId: c.sourceId, line: cardLine(c), sport: c.sport, setName: c.setName, verified: c.verified, url: c.url,
    shown: shown.filter(([, v]) => v !== ""),
  };
}

/** Search by words. One call in the `now` line per tap; nothing is stored. */
export async function searchCardsAction(_prev: SearchState, formData: FormData): Promise<SearchState> {
  await requireOwner();
  const parsed = searchSchema.safeParse({ q: str(formData.get("q")), sport: str(formData.get("sport")), year: str(formData.get("year")) });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check what you typed.", rows: [], asked: null };
  }
  const { q, sport, year } = parsed.data;
  const r = await getCatalog().search({ text: q, sport, year, limit: 20 }, "now");
  if (!r.ok) return { status: "error", message: FAILURE_MESSAGES[r.reason], rows: [], asked: q };
  // Clean cards first, then unverified listings; the screen folds the second group shut.
  const rows = r.value.map(rowOf).sort((a, b) => Number(b.verified) - Number(a.verified));
  return { status: "done", message: null, rows, asked: q };
}

/** Shown when "This is my card" is tried on an item that already has a catalog link. */
const ALREADY_LINKED = "This item is already linked. Unlink it first.";

/**
 * Add to my collection, or (with `itemId`) "This is my card". The card is
 * fetched again here by its source id through the gate, so what is stored is
 * the server's own answer and never fields sent by the browser. An
 * unverified listing is only taken when the owner ticked that they read it.
 */
export async function addCatalogCardAction(_prev: AddState, formData: FormData): Promise<AddState> {
  await requireOwner();
  const sourceId = sourceIdSchema.safeParse(str(formData.get("sourceId")));
  if (!sourceId.success) return { message: sourceId.error.issues[0]?.message ?? "That card could not be found." };
  const rawItem = str(formData.get("itemId"));
  let itemId: number | null = null;
  if (rawItem !== "") {
    const p = idSchema.safeParse(rawItem);
    if (!p.success) return { message: "This item no longer exists." };
    itemId = p.data;
  }
  const db = getDb();
  if (itemId !== null) {
    const item = db.select({ kind: items.kind, catalogCardId: items.catalogCardId }).from(items).where(and(eq(items.id, itemId), liveItem)).get();
    if (!item) return { message: "This item no longer exists." };
    if (item.kind !== "card") return { message: "Only a single card can be linked to a catalog card." };
    if (item.catalogCardId != null) return { message: ALREADY_LINKED };
  }
  const read = formData.get("readDetails") === "on";
  const got = await getCatalog().card(sourceId.data, "now");
  if (!got.ok) return { message: FAILURE_MESSAGES[got.reason] };
  const card = got.value;
  if (!card) return { message: "The catalog no longer has that card. Try the search again." };
  if (!card.verified && !read) return { message: "This is an unverified listing. Read the details, then tick the box to confirm it is your card." };

  let target: number;
  if (itemId === null) {
    const added = addCardToCollection(card, db);
    if (!added.ok) return { message: added.error };
    target = added.itemId;
    await auditThisRequest("catalog_card_added", "ok", cardLine(card));
  } else {
    const saved = saveCatalogCard(card, db);
    if (!saved.ok) return { message: saved.error };
    const linked = linkCatalogCard(itemId, saved.catalogCardId, db);
    if (!linked.ok) return { message: linked.error };
    target = itemId;
    await auditThisRequest("catalog_card_linked", "ok", cardLine(card));
  }
  refreshGuideQuietly(target);
  revalidatePath(`/items/${target}`);
  revalidatePath("/items");
  revalidatePath("/");
  redirect(`/items/${target}`);
}
