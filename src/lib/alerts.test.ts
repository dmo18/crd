import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import { scans } from "@/db/schema";
import { claimAlert, formatAlert, NOT_CONFIGURED, sendAlert, sendAlertOnce, type Alert } from "./alerts";
import { checkScanStreak, scanFailureStreak } from "./audit/alert-rules";
import { setLogSink } from "./log";

const TOKEN = "123456789:AAHfakeTokenForTestsOnly_abcdefghijklmnop";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl";
const TELEGRAM = { ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "987654321" };
const DISCORD = { ALERT_DISCORD_WEBHOOK_URL: HOOK };
const ALERT: Alert = { severity: "warning", title: "Many wrong passwords", body: "5 failed sign-ins from 203.0.113.7." };

type Call = { url: string; init: RequestInit };
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

afterEach(() => setLogSink());

describe("formatAlert", () => {
  it("is short plain text with no HTML", () => {
    const text = formatAlert({ severity: "critical", title: "<b>Hi</b> there", body: "a<script>x</script>b\u0007c" }, "telegram");
    expect(text).toBe("Card Vault Urgent: Hi there\naxb c");
    expect(text).not.toMatch(/[<>]/);
    const long = formatAlert({ severity: "info", title: "t".repeat(500), body: "b".repeat(5000) }, "telegram");
    expect(long.length).toBeLessThan(800);
  });
  it("keeps Discord from reading text as formatting", () => {
    expect(formatAlert({ severity: "info", title: "a*b_c", body: "" }, "discord")).toBe("Card Vault Note: a\\*b\\_c");
  });
});

describe("sendAlert", () => {
  it("does nothing and says why when no channel is set up", async () => {
    const f = fakeFetch();
    expect(await sendAlert(ALERT, { fetch: f.fetch, env: {} })).toEqual({ ok: false, reason: NOT_CONFIGURED });
    expect(f.calls).toHaveLength(0);
  });

  it("posts plain text to Telegram and Discord", async () => {
    const f = fakeFetch();
    expect(await sendAlert(ALERT, { fetch: f.fetch, env: { ...TELEGRAM, ...DISCORD } })).toEqual({ ok: true, sent: ["telegram", "discord"] });
    const tg = f.calls.find((c) => c.url.startsWith("https://api.telegram.org/"))!;
    expect(tg.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(tg.init.body))).toEqual({ chat_id: "987654321", text: formatAlert(ALERT, "telegram"), disable_web_page_preview: true });
    expect(tg.init.signal).toBeInstanceOf(AbortSignal);
    const dc = f.calls.find((c) => c.url === HOOK)!;
    expect(JSON.parse(String(dc.init.body))).toMatchObject({ content: formatAlert(ALERT, "discord"), allowed_mentions: { parse: [] } });
  });

  it("explains a refusal plainly and never logs the token or address", async () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const bad = fakeFetch(401);
    const r1 = await sendAlert(ALERT, { fetch: bad.fetch, env: TELEGRAM });
    expect(r1).toEqual({ ok: false, reason: expect.stringMatching(/bot token/) });
    const r2 = await sendAlert(ALERT, { fetch: fakeFetch(404).fetch, env: DISCORD });
    expect(r2).toEqual({ ok: false, reason: expect.stringMatching(/webhook/) });
    const thrower = vi.fn(async () => { throw new TypeError(`fetch failed for ${HOOK}`); }) as unknown as typeof fetch;
    expect(await sendAlert(ALERT, { fetch: thrower, env: DISCORD })).toEqual({ ok: false, reason: expect.stringMatching(/Could not reach Discord/) });
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain("AAHfakeToken");
    expect(all).not.toContain("fakeWebhookToken");
    expect(all).not.toContain("api.telegram.org");
  });

  it("gives up after the timeout and never throws", async () => {
    const hang = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const r = await sendAlert(ALERT, { fetch: hang, env: TELEGRAM, timeoutMs: 30 });
    expect(r).toEqual({ ok: false, reason: "Telegram did not answer within 1 seconds." });
  });

  it("never touches the network in tests without a fake fetch", async () => {
    expect(await sendAlert(ALERT, { env: TELEGRAM })).toEqual({ ok: false, reason: "Not sent while testing." });
  });
});

describe("cooldown", () => {
  it("claims a key at most once per cooldown", () => {
    const db = createDb(":memory:");
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(claimAlert("k", 60_000, db, t0)).toBe(true);
    expect(claimAlert("k", 60_000, db, new Date(t0.getTime() + 59_000))).toBe(false);
    expect(claimAlert("other", 60_000, db, t0)).toBe(true);
    expect(claimAlert("k", 60_000, db, new Date(t0.getTime() + 60_000))).toBe(true);
    expect(claimAlert("k", 60_000, db, new Date(t0.getTime() + 61_000))).toBe(false);
  });

  it("sends once, then waits out the cooldown", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch();
    const t0 = new Date("2026-01-01T00:00:00Z");
    const deps = { fetch: f.fetch, env: TELEGRAM, db };
    expect(await sendAlertOnce("many", 3_600_000, ALERT, { ...deps, now: t0 })).toMatchObject({ ok: true });
    expect(await sendAlertOnce("many", 3_600_000, ALERT, { ...deps, now: new Date(t0.getTime() + 60_000) })).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(1);
    expect(await sendAlertOnce("many", 3_600_000, ALERT, { ...deps, now: new Date(t0.getTime() + 3_600_000) })).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  it("claims nothing while alerts are off", async () => {
    const db = createDb(":memory:");
    expect(await sendAlertOnce("many", 3_600_000, ALERT, { env: {}, db })).toEqual({ ok: false, reason: NOT_CONFIGURED });
    expect(claimAlert("many", 3_600_000, db)).toBe(true);
  });
});

describe("scan failure streak", () => {
  function addScan(db: Db, status: "done" | "failed", minute: number) {
    db.insert(scans).values({ mode: "single", status, finishedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) }).run();
  }
  it("alerts after 3 failed scans in a row, not before", async () => {
    const db = createDb(":memory:");
    const f = fakeFetch();
    addScan(db, "failed", 1);
    addScan(db, "done", 2);
    addScan(db, "failed", 3);
    addScan(db, "failed", 4);
    expect(scanFailureStreak(db)).toBe(false);
    await checkScanStreak(db, { fetch: f.fetch, env: DISCORD });
    expect(f.calls).toHaveLength(0);
    addScan(db, "failed", 5);
    expect(scanFailureStreak(db)).toBe(true);
    await checkScanStreak(db, { fetch: f.fetch, env: DISCORD });
    await checkScanStreak(db, { fetch: f.fetch, env: DISCORD });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0]!.init.body)).content).toMatch(/Scans keep failing/);
  });
});
