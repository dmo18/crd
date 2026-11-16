import pkg from "../../../package.json";

/**
 * Every outside source the app may call, with its fixed https host(s), its
 * limits and its Test call. A URL is always built from these hosts; no part
 * of an address ever comes from the browser or from an outside answer.
 * Design: docs/PLAN.md, Milestone 10, "the shared gate for outside calls".
 */

/**
 * `demo` exists only outside production: it proves the key flow (task 10.4)
 * until Milestone 14 adds the first real source with a key. Its host ends in
 * `.invalid`, a name that never exists, so even its Test never reaches anyone.
 */
export const OUTSIDE_SOURCES = ["mycardfolio", "wikidata", "demo"] as const;
export type SourceId = (typeof OUTSIDE_SOURCES)[number];

/** Sources that exist only when NODE_ENV is not production. */
const DEV_ONLY: readonly SourceId[] = ["demo"];

/** True when this source may be used here (the demo source never in production). */
export function sourceAvailable(id: SourceId, nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production" || !DEV_ONLY.includes(id);
}

/** The sources shown on More, Connections, in order. */
export function availableSources(nodeEnv: string | undefined = process.env.NODE_ENV): SourceId[] {
  return OUTSIDE_SOURCES.filter((id) => sourceAvailable(id, nodeEnv));
}

/** One call, described without a full address. The gate builds the URL. */
export type OutsideRequest = {
  /** A fixed label for counting and logs, e.g. "search_cards". Never user text. */
  tool: string;
  /** One of the source's hosts. Defaults to the first. */
  host?: string;
  /** Fixed path starting with "/". */
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string>;
  /** Sent as a JSON body (POST only). */
  json?: unknown;
  accept?: string;
};

export type SourceConfig = {
  id: SourceId;
  name: string;
  usedFor: string;
  hosts: readonly string[];
  needsKey: boolean;
  /**
   * For a source with a key: how the gate adds it at the last step (one
   * request header), and the shape a pasted key must have.
   */
  key?: { header: string; shape: RegExp; hint: string };
  /** Least time between two call starts. */
  minGapMs: number;
  perHour: number | null;
  /** Per UTC day. */
  perDay: number | null;
  timeoutMs: number;
  /** Largest answer read, in bytes. */
  maxBytes: number;
  /** Waits before each extra try after a timeout, network error or 5xx. */
  retryDelaysMs: readonly number[];
  /** Pause after a "slow down" answer without a usable Retry-After. */
  defaultPauseMs: number;
  /** A 403 from the site's front door (Cloudflare) means "slow down". */
  pauseOn403: boolean;
  /** A 503 that carries Retry-After means "slow down" (Wikidata's habit). */
  pauseOn503WithRetryAfter: boolean;
  userAgent: () => string;
  /** One small real call for the Test button. */
  testCall: OutsideRequest;
};

/** "CardVault/0.1.0": no personal details. */
export function appUserAgent(): string {
  return `CardVault/${pkg.version}`;
}

/** Wikimedia asks every client to name a way to contact its operator. */
const WIKIDATA_DEFAULT_CONTACT = "https://github.com/dmo18/crd";

/**
 * The User-Agent sent to Wikidata, with a contact as Wikimedia's policy asks.
 * WIKIDATA_CONTACT may hold an email address or a web address; anything else
 * falls back to the project page.
 */
export function wikidataUserAgent(): string {
  const raw = (process.env.WIKIDATA_CONTACT ?? "").trim();
  const email = /^[^\s@()<>,;"]+@[^\s@()<>,;"]+\.[A-Za-z]{2,}$/;
  const web = /^https?:\/\/[^\s()<>"]+$/;
  const contact = raw.length > 0 && raw.length <= 200 && (email.test(raw) || web.test(raw)) ? raw : WIKIDATA_DEFAULT_CONTACT;
  return `CardVault/1.0 (${contact}) personal sports card collection app`;
}

const MB = 1024 * 1024;

export const SOURCES: Record<SourceId, SourceConfig> = {
  mycardfolio: {
    id: "mycardfolio",
    name: "MyCardfolio",
    usedFor: "Finds the exact card in a big free card catalog.",
    hosts: ["mycardfolio.com"],
    needsKey: false,
    minGapMs: 2000,
    perHour: 200,
    perDay: 1000,
    timeoutMs: 5000,
    maxBytes: 2 * MB,
    retryDelaysMs: [2000, 8000],
    defaultPauseMs: 15 * 60 * 1000,
    pauseOn403: true,
    pauseOn503WithRetryAfter: false,
    userAgent: appUserAgent,
    testCall: {
      tool: "search_cards",
      path: "/api/mcp",
      method: "POST",
      accept: "application/json, text/event-stream",
      json: {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search_cards", arguments: { query: "1990 Topps Griffey", limit: 1 } },
      },
    },
  },
  // Wikidata keeps its limits from before the gate: 200 ms between calls,
  // 8 s timeout, no extra tries, a 60 s pause when it gives no Retry-After.
  wikidata: {
    id: "wikidata",
    name: "Wikidata",
    usedFor: "Player facts: teams, career years, Hall of Fame.",
    hosts: ["www.wikidata.org", "query.wikidata.org"],
    needsKey: false,
    minGapMs: 200,
    perHour: null,
    perDay: null,
    timeoutMs: 8000,
    maxBytes: 2 * MB,
    retryDelaysMs: [],
    defaultPauseMs: 60_000,
    pauseOn403: false,
    pauseOn503WithRetryAfter: true,
    userAgent: wikidataUserAgent,
    testCall: {
      tool: "wbsearchentities",
      path: "/w/api.php",
      query: { action: "wbsearchentities", search: "Ken Griffey Jr.", language: "en", type: "item", limit: "1", format: "json" },
    },
  },

  demo: {
    id: "demo",
    name: "Demo source",
    usedFor: "Only for trying the key screen. Not in the live app.",
    hosts: ["demo.invalid"],
    needsKey: true,
    key: { header: "X-Demo-Key", shape: /^[A-Za-z0-9_-]+$/, hint: "Letters, digits, _ or -, 16 to 200 characters." },
    minGapMs: 2000,
    perHour: 20,
    perDay: 100,
    timeoutMs: 5000,
    maxBytes: 64 * 1024,
    retryDelaysMs: [],
    defaultPauseMs: 15 * 60 * 1000,
    pauseOn403: false,
    pauseOn503WithRetryAfter: false,
    userAgent: appUserAgent,
    testCall: { tool: "ping", path: "/ping" },
  },
};

/** A known source that may be used here (the demo source is refused in production). */
export function isSourceId(v: string): v is SourceId {
  return (OUTSIDE_SOURCES as readonly string[]).includes(v) && sourceAvailable(v as SourceId);
}
