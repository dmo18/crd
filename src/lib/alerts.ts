import { lte } from "drizzle-orm";
import { after } from "next/server";
import { getDb, type Db } from "@/db";
import { alertState } from "@/db/schema";
import { alertChannels, env, type AlertChannel, type Env } from "@/lib/env";
import { errorKind, log } from "@/lib/log";

/**
 * Short plain-text alerts to the owner's Telegram chat or Discord channel.
 * Optional: with no ALERT_* settings nothing is sent. Never throws, never
 * logs the bot token or the webhook address.
 */

export type AlertSeverity = "info" | "warning" | "critical";
export type Alert = { title: string; body: string; severity: AlertSeverity };
export type AlertResult = { ok: true; sent: AlertChannel[] } | { ok: false; reason: string };

export const ALERT_TIMEOUT_MS = 5000;
const MAX_TITLE = 100;
const MAX_BODY = 600;

type AlertEnv = Pick<Env, "ALERT_TELEGRAM_BOT_TOKEN" | "ALERT_TELEGRAM_CHAT_ID" | "ALERT_DISCORD_WEBHOOK_URL">;
export type AlertDeps = { fetch?: typeof fetch; env?: AlertEnv; timeoutMs?: number };

export const NOT_CONFIGURED =
  "Alerts are not set up. Add ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID, or ALERT_DISCORD_WEBHOOK_URL, to the server settings.";

const SEVERITY_WORD: Record<AlertSeverity, string> = { info: "Note", warning: "Warning", critical: "Urgent" };
const CHANNEL_NAME: Record<AlertChannel, string> = { telegram: "Telegram", discord: "Discord" };

function plain(text: string, max: number): string {
  const s = text
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** Discord reads its text as Markdown; a backslash keeps each mark literal. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|#\[\]])/g, "\\$1");
}

/** The message text: short, plain, no HTML. */
export function formatAlert(alert: Alert, channel: AlertChannel): string {
  const title = plain(alert.title, MAX_TITLE);
  const body = plain(alert.body, MAX_BODY);
  const text = `Card Vault ${SEVERITY_WORD[alert.severity]}: ${title}${body ? `\n${body}` : ""}`;
  return channel === "discord" ? escapeMarkdown(text) : text;
}

function request(channel: AlertChannel, e: AlertEnv, text: string): { url: string; body: unknown } {
  if (channel === "telegram") {
    return {
      url: `https://api.telegram.org/bot${e.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`,
      body: { chat_id: e.ALERT_TELEGRAM_CHAT_ID, text, disable_web_page_preview: true },
    };
  }
  // flags 4: no link previews. No @mentions, ever.
  return { url: e.ALERT_DISCORD_WEBHOOK_URL!, body: { content: text, allowed_mentions: { parse: [] }, flags: 4 } };
}

function statusReason(channel: AlertChannel, status: number): string {
  const name = CHANNEL_NAME[channel];
  if (status === 429) return `${name} says too many messages were sent. Wait a minute and try again.`;
  if (channel === "telegram") {
    if (status === 401 || status === 404) return "Telegram did not accept the bot token. Check ALERT_TELEGRAM_BOT_TOKEN.";
    if (status === 403) return "The bot may not post in that chat. Send your bot a message first, then try again.";
    if (status === 400) return "Telegram could not find that chat. Send your bot a message first, then check ALERT_TELEGRAM_CHAT_ID.";
  } else if (status === 401 || status === 403 || status === 404) {
    return "Discord did not accept the webhook. It may have been deleted. Make a new one and update ALERT_DISCORD_WEBHOOK_URL.";
  }
  return `${name} answered with an error (code ${status}). Try again later.`;
}

async function postOne(channel: AlertChannel, alert: Alert, e: AlertEnv, deps: AlertDeps): Promise<string | null> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ALERT_TIMEOUT_MS;
  const { url, body } = request(channel, e, formatAlert(alert, channel));
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      cache: "no-store",
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return null;
    log.warn("alert_failed", { channel, status: res.status });
    return statusReason(channel, res.status);
  } catch (err) {
    const kind = errorKind(err);
    log.warn("alert_failed", { channel, error: kind });
    if (kind === "TimeoutError" || kind === "AbortError") return `${CHANNEL_NAME[channel]} did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`;
    return `Could not reach ${CHANNEL_NAME[channel]}. Check that the server can reach the internet.`;
  }
}

function alertEnv(deps: AlertDeps): AlertEnv | null {
  if (deps.env) return deps.env;
  try {
    return env();
  } catch {
    return null;
  }
}

/** Sends to every channel that is set up. Never throws. */
export async function sendAlert(alert: Alert, deps: AlertDeps = {}): Promise<AlertResult> {
  try {
    const e = alertEnv(deps);
    if (!e) return { ok: false, reason: "The server settings have a problem, so alerts cannot be sent." };
    const channels = alertChannels(e as Env);
    if (channels.length === 0) return { ok: false, reason: NOT_CONFIGURED };
    // Tests never reach the network: without a fake fetch nothing is sent.
    if (process.env.VITEST && !deps.fetch) return { ok: false, reason: "Not sent while testing." };
    const problems = await Promise.all(channels.map((c) => postOne(c, alert, e, deps)));
    const failed = problems.filter((p): p is string => p !== null);
    if (failed.length > 0) return { ok: false, reason: failed.join(" ") };
    log.info("alert_sent", { channels: channels.join(",") });
    return { ok: true, sent: channels };
  } catch (err) {
    log.error("alert_failed", { error: errorKind(err) });
    return { ok: false, reason: "Something went wrong while sending. Try again." };
  }
}

/**
 * Claims the right to send the alert `key` now. True at most once per
 * `cooldownMs`, even when two requests race (one atomic statement).
 */
export function claimAlert(key: string, cooldownMs: number, db: Db = getDb(), now: Date = new Date()): boolean {
  const rows = db.insert(alertState).values({ key, lastSentAt: now })
    .onConflictDoUpdate({
      target: alertState.key,
      set: { lastSentAt: now },
      setWhere: lte(alertState.lastSentAt, new Date(now.getTime() - cooldownMs)),
    })
    .returning({ key: alertState.key }).all();
  return rows.length > 0;
}

export type AlertOnceDeps = AlertDeps & { db?: Db; now?: Date };

/**
 * Sends the alert unless one with the same key went out within `cooldownMs`.
 * Nothing is claimed while alerts are not set up. Never throws.
 */
export async function sendAlertOnce(key: string, cooldownMs: number, alert: Alert, deps: AlertOnceDeps = {}): Promise<AlertResult> {
  try {
    const e = alertEnv(deps);
    if (!e || alertChannels(e as Env).length === 0) return { ok: false, reason: NOT_CONFIGURED };
    if (!claimAlert(key, cooldownMs, deps.db ?? getDb(), deps.now ?? new Date())) {
      return { ok: false, reason: "Sent recently, so not repeated yet." };
    }
    return await sendAlert(alert, { ...deps, env: e });
  } catch (err) {
    log.error("alert_failed", { error: errorKind(err) });
    return { ok: false, reason: "Something went wrong while sending. Try again." };
  }
}

/**
 * Sends the alert after the response has gone out, so the visitor never
 * waits for Telegram or Discord. Outside a request it starts right away.
 */
export function queueAlert(key: string, cooldownMs: number, alert: Alert): void {
  const run = () => sendAlertOnce(key, cooldownMs, alert).then(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
