import { z } from "zod";
import type { Db } from "@/db";
import { outsideCall, type OutsideFailure } from "@/lib/outside/gate";
import type { CacheKind } from "@/lib/outside/cache";
import type { Catalog, CatalogCard, CatalogFailure, CatalogResult, Line } from "./types";
import { MAX_SUBJECTS, cleanCardNumber, cleanName, cleanSetName, cleanSport, cleanYear, isCleanId, setIdFromUrl, sourceUrl, splitProduct } from "./clean";

/**
 * MyCardfolio through the shared gate (every call goes through `outsideCall`).
 * Wire format and rules: docs/PLAN.md, Milestone 10, "MyCardfolio client";
 * what the probe found: docs/CATALOG-TRIAL.md, "Checklist probe".
 * Nothing here throws for a bad answer: it gives `failed` or drops the row.
 */

const HOME = "https://mycardfolio.com";
const MAX_NOISE = 3;
const CHECKLIST_TIMEOUT_MS = 10_000;
/** The source sends at most 500 checklist rows; that many means the set may go on. */
const CHECKLIST_CAP = 500;
const DEFAULT_LIMIT = 20;

// ---------- reading the answer ----------

const rpcSchema = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(), isError: z.boolean().optional() }).passthrough().optional(),
  error: z.unknown().optional(),
});

export type Inner = { kind: "json"; value: unknown } | { kind: "text"; text: string } | { kind: "error" };

/** The JSON-RPC answer (an SSE `data:` line, or plain JSON) and the second JSON inside it. */
export function readAnswer(body: string): Inner {
  let outer: unknown = undefined;
  const lines = String(body ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      outer = JSON.parse(line.slice(5).trim());
      break;
    } catch {
      // try the next data line
    }
  }
  if (outer === undefined) {
    try {
      outer = JSON.parse(String(body ?? ""));
    } catch {
      return { kind: "error" };
    }
  }
  const rpc = rpcSchema.safeParse(outer);
  if (!rpc.success || rpc.data.error !== undefined || rpc.data.result?.isError) return { kind: "error" };
  const text = rpc.data.result?.content?.[0]?.text;
  if (typeof text !== "string") return { kind: "error" };
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "text", text };
  }
}

const str = z.union([z.string(), z.number()]).nullish();
const rowSchema = z
  .object({
    card_id: z.union([z.string(), z.number()]),
    sport: str,
    year: str,
    product: str,
    set: str,
    card_number: str,
    subjects: z.array(z.unknown()).nullish(),
    card_details: str,
    url: z.string().nullish(),
  })
  .passthrough();

const setSchema = z.object({ set_id: z.union([z.string(), z.number()]).nullish() }).passthrough();

const searchSchema = z.object({ count: z.number().nullish(), results: z.array(z.unknown()) }).passthrough();
const cardSchema = z.object({ card: z.unknown(), set: z.unknown().optional() }).passthrough();
const checklistSchema = z
  .object({ set: z.unknown().optional(), total_cards: z.number().nullish(), note: z.string().nullish(), cards: z.array(z.unknown()) })
  .passthrough();

function s(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** One answer row to a cleaned card, or null when it is unusable. */
export function toCard(rawRow: unknown, setIdHint: string | null = null): CatalogCard | null {
  const parsed = rowSchema.safeParse(rawRow);
  if (!parsed.success) return null;
  const r = parsed.data;
  const sourceId = s(r.card_id).trim();
  if (!/^[A-Za-z0-9_]{1,40}$/.test(sourceId)) return null;
  const verified = isCleanId(sourceId);

  const names: string[] = [];
  const tags: string[] = [];
  // Only the first few players: a card never has more, and a huge list must stay cheap.
  for (const subj of (r.subjects ?? []).slice(0, MAX_SUBJECTS)) {
    const o = z.object({ subject_name: z.string().nullish() }).passthrough().safeParse(subj);
    if (!o.success) continue;
    const c = cleanName(o.data.subject_name);
    if (c.name && !names.includes(c.name)) names.push(c.name);
    // Rookie and other words on listings are not trusted: tags only from clean entries.
    if (verified) for (const t of c.tags) if (!tags.includes(t)) tags.push(t);
  }
  const { brand, variation } = splitProduct(s(r.product));
  const url = sourceUrl(r.url) ?? HOME;
  const fromUrl = verified ? setIdFromUrl(url) : null;
  const hint = verified && setIdHint && /^\d{1,12}$/.test(setIdHint) ? setIdHint : null;
  return {
    source: "mycardfolio",
    sourceId,
    url,
    sourceSetId: fromUrl ?? hint,
    verified,
    sport: cleanSport(s(r.sport)),
    year: cleanYear(r.year),
    brand,
    setName: verified ? cleanSetName(s(r.set)) : null,
    cardNumber: cleanCardNumber(r.card_number),
    player: names[0] ?? null,
    otherPlayers: names.slice(1),
    variation,
    tags,
  };
}

function setIdOf(block: unknown): string | null {
  const p = setSchema.safeParse(block);
  const id = p.success ? s(p.data.set_id).trim() : "";
  return /^\d{1,12}$/.test(id) ? id : null;
}

/** Clean entries first; noise only when there is no clean entry, at most 3, never verified. */
export function applyNoiseRule(cards: CatalogCard[], limit: number): CatalogCard[] {
  const clean = cards.filter((c) => c.verified);
  return (clean.length > 0 ? clean : cards.slice(0, MAX_NOISE)).slice(0, limit);
}

export type SearchParsed = CatalogCard[];

/**
 * The cards of a search answer. `[]` ("nothing found", stored for a day) only
 * when the site says count 0 with an empty list; null (failed, not stored)
 * for anything else that gives no usable row.
 */
export function parseSearch(body: string, limit = DEFAULT_LIMIT): SearchParsed | null {
  const a = readAnswer(body);
  // The site says "nothing found" as JSON with count 0 and an empty list
  // (recorded in search_empty_eriffey.json), never as a sentence. So any plain text is a failure.
  if (a.kind !== "json") return null;
  const p = searchSchema.safeParse(a.value);
  if (!p.success) return null;
  if (p.data.results.length === 0) return p.data.count === 0 ? [] : null;
  const cards = p.data.results.map((row) => toCard(row)).filter((c): c is CatalogCard => c !== null);
  // Rows that are all unusable: a broken answer, not "nothing found".
  if (cards.length === 0) return null;
  return applyNoiseRule(cards, limit);
}

/** null: unreadable answer. `{card: null}`: the site says there is no such card. */
export function parseCard(body: string): { card: CatalogCard | null } | null {
  const a = readAnswer(body);
  if (a.kind === "text") return /^no card found/i.test(a.text.trim()) ? { card: null } : null;
  if (a.kind !== "json") return null;
  const p = cardSchema.safeParse(a.value);
  if (!p.success) return null;
  const card = toCard(p.data.card, setIdOf(p.data.set));
  return card ? { card } : null;
}

export function parseChecklist(body: string, requestedSetId: string): { cards: CatalogCard[]; complete: boolean } | null {
  const a = readAnswer(body);
  if (a.kind !== "json") return null;
  const p = checklistSchema.safeParse(a.value);
  if (!p.success) return null;
  const answered = setIdOf(p.data.set);
  // An answer for another set than the one asked for is not used.
  if (answered !== null && answered !== requestedSetId) return null;
  const hint = answered ?? requestedSetId;
  const cards = p.data.cards.map((row) => toCard(row, hint)).filter((c): c is CatalogCard => c !== null && c.verified);
  const total = typeof p.data.total_cards === "number" ? p.data.total_cards : null;
  const truncated =
    Boolean(p.data.note) ||
    p.data.cards.length >= CHECKLIST_CAP ||
    (total !== null && p.data.cards.length < total) ||
    (total !== null && cards.length < total);
  return { cards, complete: !truncated };
}

// ---------- calls ----------

function failure(reason: OutsideFailure): CatalogFailure {
  switch (reason) {
    case "off":
    case "needs_key":
      return "off";
    case "paused":
    case "slow_down":
      return "paused";
    case "capped":
      return "cap";
    case "busy":
      return "busy";
    default:
      return "failed";
  }
}

export type ClientOptions = { db?: Db; fetchImpl?: typeof fetch };

export function createMyCardfolio(options: ClientOptions = {}): Catalog {
  async function run<T>(
    tool: string,
    args: Record<string, string | number>,
    line: Line,
    parse: (body: string) => T | null,
    kindOf: (v: T) => CacheKind,
    timeoutMs?: number,
  ): Promise<CatalogResult<T>> {
    const r = await outsideCall(
      "mycardfolio",
      {
        tool,
        path: "/api/mcp",
        method: "POST",
        accept: "application/json, text/event-stream",
        json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
      },
      {
        line,
        db: options.db,
        fetchImpl: options.fetchImpl,
        timeoutMs,
        // Only an answer that parses is kept. The arguments are the exact ones sent.
        cache: { args, kindOf: (body) => { const v = parse(body); return v === null ? null : kindOf(v); } },
      },
    );
    if (!r.ok) return { ok: false, reason: failure(r.reason) };
    const value = parse(r.body);
    if (value === null) return { ok: false, reason: "failed" };
    return { ok: true, value, fromStore: r.fromStore };
  }

  return {
    async search(q, line) {
      const text = String(q.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (text.length < 2) return { ok: true, value: [], fromStore: false };
      const asked = Number(q.limit ?? DEFAULT_LIMIT);
      const limit = Number.isFinite(asked) ? Math.min(50, Math.max(1, Math.trunc(asked))) : DEFAULT_LIMIT;
      const args: Record<string, string | number> = { query: text, limit };
      if (q.sport) args.sport = q.sport[0].toUpperCase() + q.sport.slice(1);
      if (q.year && Number.isInteger(q.year)) args.year = String(q.year);
      return run("search_cards", args, line, (b) => parseSearch(b, limit), (v) => (v.length > 0 ? "search" : "search_empty"));
    },
    async card(sourceId, line) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(String(sourceId ?? ""))) return { ok: true, value: null, fromStore: false };
      return run("get_card", { card_id: sourceId }, line, (b) => parseCard(b), (v) => (v.card ? "card" : "search_empty")).then(
        (r): CatalogResult<CatalogCard | null> => (r.ok ? { ok: true, value: r.value.card, fromStore: r.fromStore } : r),
      );
    },
    async checklist(sourceSetId, line) {
      if (!/^\d{1,12}$/.test(String(sourceSetId ?? ""))) return { ok: false, reason: "failed" };
      return run("get_set_checklist", { set_id: sourceSetId }, line, (b) => parseChecklist(b, sourceSetId), () => "checklist", CHECKLIST_TIMEOUT_MS);
    },
  };
}

