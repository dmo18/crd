import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { cardSets, checklistEntries, items, wantedCards, type CardSetRow, type Sport } from "@/db/schema";
import { liveItem } from "@/lib/items/live";
import { playerAgrees } from "@/lib/catalog/find";
import { withNameSuffix } from "@/lib/catalog/mycardfolio";
import { compareNumbers, keyOfFields as setKeyOfFields, numberKeyOf, parseSetKey, setIdentityOf, setKeyOf, setLabel, setTitle, type SetIdentity } from "./identity";

/**
 * The owner's sets and one set's page (Milestone 15). Built from the owner's
 * own items (liveItem: sold, removed and deleted items do not count) and, when
 * the owner fetched it, the set's stored checklist. No outside call here.
 */

/** Checklists are kept this long, like the stored catalog answers (storage policy, docs/SPEC.md). */
export const CHECKLIST_KEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export type OwnedCard = {
  id: number;
  title: string;
  inReview: boolean;
  cardNumber: string | null;
  numberKey: string | null;
  player: string | null;
  quantity: number;
};

type Spelling = { sport: Sport | null; year: number; brand: string | null; setName: string | null };
type Group = { key: string; identity: SetIdentity; spelling: Spelling; cards: OwnedCard[] };

/** Every live card with a year, grouped by set. */
function groups(db: Db): Map<string, Group> {
  const rows = db
    .select({
      id: items.id, title: items.title, status: items.status, sport: items.sport, year: items.year, brand: items.brand,
      setName: items.setName, cardNumber: items.cardNumber, player: items.player, quantity: items.quantity,
    })
    .from(items)
    .where(and(liveItem, eq(items.kind, "card"), isNotNull(items.year)))
    .orderBy(asc(items.id))
    .all();
  const out = new Map<string, Group>();
  const spellings = new Map<string, Map<string, { n: number; s: Spelling }>>();
  for (const r of rows) {
    const identity = setIdentityOf(r);
    if (!identity) continue;
    const key = setKeyOf(identity);
    const s: Spelling = { sport: r.sport, year: r.year!, brand: r.brand?.trim() || null, setName: r.setName?.trim() || null };
    let g = out.get(key);
    if (!g) out.set(key, (g = { key, identity, spelling: s, cards: [] }));
    g.cards.push({
      id: r.id, title: r.title, inReview: r.status === "needs_review", cardNumber: r.cardNumber?.trim() || null,
      numberKey: numberKeyOf(r.cardNumber), player: r.player?.trim() || null, quantity: r.quantity,
    });
    // The spelling most of the set's cards use, for the screen.
    const counts = spellings.get(key) ?? new Map();
    spellings.set(key, counts);
    const sk = `${s.brand ?? ""}|${s.setName ?? ""}`;
    const c = counts.get(sk) ?? { n: 0, s };
    c.n += 1;
    counts.set(sk, c);
    if (c.n > (counts.get(`${g.spelling.brand ?? ""}|${g.spelling.setName ?? ""}`)?.n ?? 0)) g.spelling = s;
  }
  return out;
}

/** Distinct cards: several copies of one number count once; a card without a number counts on its own. */
function distinctOwned(cards: readonly OwnedCard[]): number {
  const numbers = new Set<string>();
  let blank = 0;
  for (const c of cards) {
    if (c.numberKey) numbers.add(c.numberKey);
    else blank += 1;
  }
  return numbers.size + blank;
}

/**
 * Distinct cards with a copy still in Review: a part of the owned count,
 * never added to it (review 7).
 */
function distinctInReview(cards: readonly OwnedCard[]): number {
  return distinctOwned(cards.filter((c) => c.inReview));
}

/** "3 cards owned", "1 card owned (in Review)", "3 cards owned (1 in Review)". */
export function ownedLine(owned: number, inReview: number): string {
  const head = `${owned} ${owned === 1 ? "card" : "cards"} owned`;
  if (inReview <= 0) return head;
  return inReview >= owned ? `${head} (in Review)` : `${head} (${inReview} in Review)`;
}

/** "3 copies" for a card held more than once (quantities added), else null. */
export function copiesLine(copies: number): string | null {
  return copies > 1 ? `${copies} copies` : null;
}

export type SetSummary = {
  key: string;
  label: string;
  /** The label without the sport. */
  title: string;
  sport: Sport | null;
  year: number;
  /** Distinct cards owned. */
  owned: number;
  inReview: number;
  /** Only with a complete stored checklist. */
  percent: number | null;
  hasChecklist: boolean;
};

/** The Sets screen: every set the owner has cards from, by sport, then year and name. */
export function listOwnedSets(db: Db = getDb()): SetSummary[] {
  const all = [...groups(db).values()];
  const stored = all.length === 0 ? [] : db.select().from(cardSets).where(inArray(cardSets.key, all.map((g) => g.key))).all();
  const byKey = new Map(stored.map((s) => [s.key, s]));
  return all
    .map((g) => {
      const row = byKey.get(g.key) ?? null;
      let percent: number | null = null;
      let hasChecklist = false;
      if (row && row.checklistAt && !checklistExpired(row)) {
        const view = setView(g.key, db, { groupsCache: g });
        hasChecklist = view?.checklist?.present ?? false;
        percent = view?.percent ?? null;
      }
      return {
        key: g.key, label: setLabel(g.spelling), title: setTitle(g.spelling), sport: g.spelling.sport, year: g.identity.year,
        owned: distinctOwned(g.cards), inReview: distinctInReview(g.cards), percent, hasChecklist,
      };
    })
    .sort((a, b) => (a.sport ?? "zz").localeCompare(b.sport ?? "zz") || a.year - b.year || a.label.localeCompare(b.label));
}

export function checklistExpired(row: Pick<CardSetRow, "checklistAt">, now: Date = new Date()): boolean {
  return row.checklistAt != null && now.getTime() - row.checklistAt.getTime() > CHECKLIST_KEEP_DAYS * DAY;
}

export type SetRow = {
  numberKey: string | null;
  cardNumber: string | null;
  player: string | null;
  team: string | null;
  /** The card's page at the catalog, for missing cards. */
  url: string | null;
  owned: boolean;
  wanted: boolean;
  /** The owner's copies (one or more items), in Review or not. */
  items: { id: number; title: string; inReview: boolean; quantity: number }[];
  /** On the stored checklist (false: owned, but the catalog's list does not have this number). */
  onList: boolean;
  /** Set when the owner's card has this number but another player: the list's name, to check. */
  listSays: string | null;
};

export type SetView = {
  key: string;
  label: string;
  identity: SetIdentity;
  spelling: Spelling;
  set: CardSetRow | null;
  checklist: null | {
    present: boolean;
    /** The stored list was older than 30 days and was cleared. */
    expired: boolean;
    at: Date;
    complete: boolean;
    total: number | null;
    listed: number;
  };
  rows: SetRow[];
  /** Cards of this set whose number is blank: "Owned, number not known". */
  noNumber: OwnedCard[];
  counts: { owned: number; ownedOnList: number; missing: number; wanted: number; inReview: number };
  /** Percent complete, only with a complete checklist. */
  percent: number | null;
};

/**
 * One set's page, or null when the key is not one of the owner's sets and
 * nothing is stored for it. Wanted marks the owner now owns are dropped here
 * (the card was scanned or added since). An expired checklist is cleared here.
 */
export function setView(key: string, db: Db = getDb(), opts: { now?: Date; groupsCache?: Group } = {}): SetView | null {
  const identity = parseSetKey(key);
  if (!identity) return null;
  const now = opts.now ?? new Date();
  const group = opts.groupsCache ?? groups(db).get(key) ?? null;
  const set = db.select().from(cardSets).where(eq(cardSets.key, key)).get() ?? null;
  if (!group && !set) return null;
  const spelling: Spelling = group?.spelling ?? { sport: set!.sport, year: set!.year, brand: set!.brand, setName: set!.setName };
  const cards = group?.cards ?? [];

  let entries = set ? db.select().from(checklistEntries).where(eq(checklistEntries.setId, set.id)).orderBy(asc(checklistEntries.position)).all() : [];
  let expired = false;
  if (set && checklistExpired(set, now)) {
    expired = true;
    if (entries.length > 0) {
      db.delete(checklistEntries).where(eq(checklistEntries.setId, set.id)).run();
      entries = [];
    }
  }

  const byNumber = new Map<string, OwnedCard[]>();
  const noNumber: OwnedCard[] = [];
  for (const c of cards) {
    if (!c.numberKey) noNumber.push(c);
    else byNumber.set(c.numberKey, [...(byNumber.get(c.numberKey) ?? []), c]);
  }

  // A wanted card the owner now has loses its mark.
  if (set) {
    const owned = [...byNumber.keys()];
    if (owned.length > 0) db.delete(wantedCards).where(and(eq(wantedCards.setId, set.id), inArray(wantedCards.numberKey, owned))).run();
  }
  const wants = set ? db.select().from(wantedCards).where(eq(wantedCards.setId, set.id)).all() : [];
  const wantedKeys = new Set(wants.map((w) => w.numberKey));

  const rows = new Map<string, SetRow>();
  const itemsOf = (list: OwnedCard[] | undefined) => (list ?? []).map((c) => ({ id: c.id, title: c.title, inReview: c.inReview, quantity: c.quantity }));
  for (const e of entries) {
    if (!e.numberKey || rows.has(e.numberKey)) continue;
    // A list stored before the suffix rule (team "Jr.") reads the same as a new one.
    const { player, team } = withNameSuffix(e.player, e.team);
    const mine = byNumber.get(e.numberKey);
    // The player is the check: a copy with another player's name is shown with the list's name.
    const named = (mine ?? []).filter((c) => c.player);
    const listSays = player && named.length > 0 && !named.some((c) => playerAgrees(c.player, player)) ? player : null;
    rows.set(e.numberKey, {
      numberKey: e.numberKey, cardNumber: e.cardNumber, player, team, url: e.url,
      owned: Boolean(mine), wanted: !mine && wantedKeys.has(e.numberKey), items: itemsOf(mine), onList: true, listSays,
    });
  }
  const listed = rows.size;
  for (const [nk, mine] of byNumber) {
    if (rows.has(nk)) continue;
    rows.set(nk, {
      numberKey: nk, cardNumber: mine[0].cardNumber, player: mine.find((c) => c.player)?.player ?? null, team: null, url: null,
      owned: true, wanted: false, items: itemsOf(mine), onList: false, listSays: null,
    });
  }
  for (const w of wants) {
    if (rows.has(w.numberKey)) continue;
    rows.set(w.numberKey, {
      numberKey: w.numberKey, cardNumber: w.cardNumber, player: w.player, team: null, url: null,
      owned: false, wanted: true, items: [], onList: false, listSays: null,
    });
  }
  const sorted = [...rows.values()].sort((a, b) => compareNumbers(a.numberKey, b.numberKey));

  const present = entries.length > 0;
  const complete = present && set?.checklistComplete === true;
  const ownedOnList = sorted.filter((r) => r.owned && r.onList).length;
  const percent = complete && listed > 0 ? Math.floor((ownedOnList * 100) / listed) : null;

  return {
    key, label: setLabel(spelling), identity, spelling, set,
    checklist: set?.checklistAt
      ? { present, expired, at: set.checklistAt, complete, total: set.checklistTotal, listed }
      : null,
    rows: sorted,
    noNumber,
    counts: {
      owned: distinctOwned(cards),
      ownedOnList,
      missing: sorted.filter((r) => !r.owned && r.onList).length,
      wanted: sorted.filter((r) => r.wanted).length,
      inReview: distinctInReview(cards),
    },
    percent,
  };
}

/** How many sets the owner has cards from (for the More page line). */
export function ownedSetCount(db: Db = getDb()): number {
  return groups(db).size;
}

/** Live cards that are in no set: no year, or no brand and no set name. */
export function cardsWithoutSet(db: Db = getDb()): number {
  const all = Number(db.select({ n: sql<number>`count(*)` }).from(items).where(and(liveItem, eq(items.kind, "card"))).get()?.n ?? 0);
  let inSets = 0;
  for (const g of groups(db).values()) inSets += g.cards.length;
  return Math.max(0, all - inSets);
}

/** The cards of the set the owner has, for the loader (which asks the catalog for the set's id). */
export function ownedCardsOf(key: string, db: Db = getDb()): { spelling: Spelling; cards: OwnedCard[] } | null {
  const g = groups(db).get(key);
  return g ? { spelling: g.spelling, cards: g.cards } : null;
}

export type SetStat = { key: string; label: string; units: number; valueCents: number };

/**
 * Home's "By set": units and value per set (the same rule as every other
 * total: the owner's figure, else the estimate, else 0, times the quantity),
 * biggest value first, each leading to its set page.
 */
export function setBreakdown(limit: number, db: Db = getDb()): SetStat[] {
  const rows = db
    .select({
      sport: items.sport, year: items.year, brand: items.brand, setName: items.setName, quantity: items.quantity,
      unit: sql<number>`coalesce(${items.manualValueCents}, ${items.estValueCents}, 0)`,
    })
    .from(items)
    .where(and(liveItem, eq(items.kind, "card"), isNotNull(items.year)))
    .all();
  const byKey = new Map<string, SetStat>();
  for (const g of groups(db).values()) byKey.set(g.key, { key: g.key, label: setLabel(g.spelling), units: 0, valueCents: 0 });
  for (const r of rows) {
    const key = setKeyOfFields(r);
    const s = key ? byKey.get(key) : undefined;
    if (!s) continue;
    s.units += r.quantity;
    s.valueCents += Number(r.unit) * r.quantity;
  }
  return [...byKey.values()]
    .sort((a, b) => b.valueCents - a.valueCents || b.units - a.units || a.label.localeCompare(b.label))
    .slice(0, limit);
}
