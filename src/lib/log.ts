/**
 * Tiny structured logger: one JSON line per event on stdout, for the hosting
 * panel's log view. Fields pass through `redact` first, so secrets, cookies,
 * photo data and request bodies never reach the log.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const MAX_STRING = 200;
const MAX_DEPTH = 3;
const MAX_KEYS = 30;
const REDACTED = "[redacted]";

/** Field names whose values are never logged, whatever they hold. */
const SECRET_KEY = /pass|secret|token|cookie|auth|session|hash|api.?key|setup.?code|^code$|webhook|photo|image|^data$|body|credential|signature/i;

/** Secret-looking text inside otherwise safe strings. */
const SECRET_TEXT: [RegExp, string][] = [
  // Telegram bot tokens, also inside https://api.telegram.org/bot<token>/...
  [/\d{5,15}:[A-Za-z0-9_-]{30,}/g, REDACTED],
  // Discord webhook addresses
  [/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\S*/gi, REDACTED],
  // iron-session sealed cookies
  [/Fe26\.2\*\S+/g, REDACTED],
  // Authorization header values
  [/\b(Bearer|Basic)\s+\S+/gi, "$1 " + REDACTED],
  // bcrypt hashes
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g, REDACTED],
  // Long unbroken strings of letters and digits (keys, base64 data)
  [/[A-Za-z0-9+/_=-]{40,}/g, REDACTED],
];

function cleanString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of SECRET_TEXT) out = out.replace(pattern, replacement);
  // No control characters, so one event stays one line.
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...` : out;
}

function cleanValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return cleanString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return value.name;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || (typeof Blob !== "undefined" && value instanceof Blob)) return "[binary]";
  if (typeof FormData !== "undefined" && value instanceof FormData) return REDACTED;
  if (typeof Headers !== "undefined" && value instanceof Headers) return REDACTED;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => cleanValue(v, depth + 1));
  if (typeof value === "object") return redactObject(value as Record<string, unknown>, depth + 1);
  return undefined;
}

function redactObject(fields: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields).slice(0, MAX_KEYS)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const cleaned = cleanValue(value, depth);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** A copy of `fields` that is safe to log. Never throws. */
export function redact(fields: LogFields): LogFields {
  try {
    return redactObject(fields, 0);
  } catch {
    return {};
  }
}

type Sink = (line: string) => void;
// Quiet under the test runner; tests that check output swap in their own sink.
const defaultSink: Sink = process.env.VITEST ? () => undefined : (line) => console.log(line);
let sink: Sink = defaultSink;

/** For tests only. Pass nothing to restore the normal output. */
export function setLogSink(next?: Sink): void {
  sink = next ?? defaultSink;
}

const EVENT_NAME = /^[a-z0-9_.:-]{1,64}$/i;

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    const { requestId, ...rest } = fields;
    const line: LogFields = {
      time: new Date().toISOString(),
      level,
      event: EVENT_NAME.test(event) ? event : "invalid_event_name",
    };
    if (typeof requestId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(requestId)) line.requestId = requestId;
    Object.assign(line, redact(rest));
    sink(JSON.stringify(line));
  } catch {
    // Logging must never break a request.
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};

/** The kind of an error, safe to log. Never its message, which may hold user input. */
export function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

/** Header the proxy sets on every request with a fresh id, for matching log lines. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The request id the proxy set, or undefined. */
export function requestIdFrom(headers: Headers): string | undefined {
  const id = headers.get(REQUEST_ID_HEADER);
  return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : undefined;
}
