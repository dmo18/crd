import { afterEach, describe, expect, it } from "vitest";
import { alertChannels, appOriginHost, env, resetEnvCache } from "./env";

const saved = { ...process.env };
function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

afterEach(() => {
  for (const k of ["APP_ORIGIN", "TRUST_PROXY_HOPS", "CLIENT_IP_HEADER", "NODE_ENV", "OWNER_PASSWORD_HASH_B64", "SETUP_CODE",
    "ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_DISCORD_WEBHOOK_URL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("APP_ORIGIN", () => {
  it("is optional, and empty means unset", () => {
    withEnv({ APP_ORIGIN: "" });
    expect(env().APP_ORIGIN).toBeUndefined();
    expect(appOriginHost()).toBeNull();
  });
  it("accepts a bare address and gives its host", () => {
    withEnv({ APP_ORIGIN: "https://Cards.Example.com" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    withEnv({ APP_ORIGIN: "https://cards.example.com" });
    expect(appOriginHost()).toBe("cards.example.com");
    withEnv({ APP_ORIGIN: "http://localhost:3000" });
    expect(appOriginHost()).toBe("localhost:3000");
  });
  it("tidies a trailing slash or path, and rejects another protocol or a bare name", () => {
    withEnv({ APP_ORIGIN: "https://cards.example.com/app/" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    for (const bad of ["ftp://cards.example.com", "cards.example.com"]) {
      withEnv({ APP_ORIGIN: bad });
      expect(() => env(), bad).toThrow(/APP_ORIGIN/);
    }
  });
  it("RULE CHANGE: http is upgraded to https in production instead of rejected", () => {
    withEnv({ NODE_ENV: "production", APP_ORIGIN: "http://cards.example.com" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    withEnv({ NODE_ENV: "production", APP_ORIGIN: "http://cards.example.com:3000" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    withEnv({ NODE_ENV: "production", APP_ORIGIN: "https://cards.example.com" });
    expect(env().APP_ORIGIN).toBe("https://cards.example.com");
    withEnv({ NODE_ENV: "development", APP_ORIGIN: "http://cards.example.com" });
    expect(env().APP_ORIGIN).toBe("http://cards.example.com");
  });
  it("keeps http in production for this computer only, and upgrades any other host", () => {
    for (const ok of ["http://localhost:3300", "http://127.0.0.1:3300", "http://[::1]:3300"]) {
      withEnv({ NODE_ENV: "production", APP_ORIGIN: ok });
      expect(env().APP_ORIGIN, ok).toBe(ok);
    }
    for (const [given, upgraded] of [["http://localhost.example.com", "https://localhost.example.com"], ["http://127.0.0.2", "https://127.0.0.2"], ["http://10.0.0.1:3000", "https://10.0.0.1"]]) {
      withEnv({ NODE_ENV: "production", APP_ORIGIN: given });
      expect(env().APP_ORIGIN, given).toBe(upgraded);
    }
  });
});

describe("CLIENT_IP_HEADER", () => {
  it("is optional, and empty means off", () => {
    withEnv({ CLIENT_IP_HEADER: undefined });
    expect(env().CLIENT_IP_HEADER).toBeUndefined();
    withEnv({ CLIENT_IP_HEADER: "  " });
    expect(env().CLIENT_IP_HEADER).toBeUndefined();
  });
  it("accepts a header name and stores it lowercase", () => {
    withEnv({ CLIENT_IP_HEADER: "CF-Connecting-IP" });
    expect(env().CLIENT_IP_HEADER).toBe("cf-connecting-ip");
  });
  it("rejects anything that is not a plain header name", () => {
    for (const bad of ["cf connecting ip", "x_real_ip", "a:b", "a".repeat(65), "1.1.1.1,x"]) {
      withEnv({ CLIENT_IP_HEADER: bad });
      expect(() => env(), bad).toThrow(/CLIENT_IP_HEADER/);
    }
  });
});

describe("password settings", () => {
  it("OWNER_PASSWORD_HASH_B64 is optional, and empty means unset", () => {
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined });
    expect(env().OWNER_PASSWORD_HASH_B64).toBeUndefined();
    withEnv({ OWNER_PASSWORD_HASH_B64: "" });
    expect(env().OWNER_PASSWORD_HASH_B64).toBeUndefined();
  });
  it("SETUP_CODE is optional but at least 16 characters", () => {
    withEnv({ SETUP_CODE: "" });
    expect(env().SETUP_CODE).toBeUndefined();
    withEnv({ SETUP_CODE: "short-code" });
    expect(() => env()).toThrow(/SETUP_CODE/);
    withEnv({ SETUP_CODE: "a".repeat(16) });
    expect(env().SETUP_CODE).toBe("a".repeat(16));
  });
});

describe("TRUST_PROXY_HOPS", () => {
  it("defaults to 0", () => {
    withEnv({ TRUST_PROXY_HOPS: undefined });
    expect(env().TRUST_PROXY_HOPS).toBe(0);
    withEnv({ TRUST_PROXY_HOPS: "" });
    expect(env().TRUST_PROXY_HOPS).toBe(0);
  });
  it("accepts 0 to 5 only", () => {
    withEnv({ TRUST_PROXY_HOPS: "2" });
    expect(env().TRUST_PROXY_HOPS).toBe(2);
    for (const bad of ["6", "-1", "1.5", "two"]) {
      withEnv({ TRUST_PROXY_HOPS: bad });
      expect(() => env(), bad).toThrow(/TRUST_PROXY_HOPS/);
    }
  });
});

describe("APP_ORIGIN from a hosting panel", () => {
  it("keeps only the origin when a trailing slash or path is included", async () => {
    const { env, resetEnvCache } = await import("./env");
    const before = process.env.APP_ORIGIN;
    for (const [given, expected] of [["https://cards.example.com/", "https://cards.example.com"], ["https://cards.example.com/x/y", "https://cards.example.com"], [" https://cards.example.com ", "https://cards.example.com"], ["https://cards.example.com:3000", "https://cards.example.com"], ["https://cards.example.com:8443/", "https://cards.example.com:8443"]]) {
      process.env.APP_ORIGIN = given;
      resetEnvCache();
      expect(env().APP_ORIGIN).toBe(expected);
    }
    process.env.APP_ORIGIN = before;
    if (before === undefined) delete process.env.APP_ORIGIN;
    resetEnvCache();
  });
});


describe("alert settings", () => {
  const TOKEN = "123456789:AAHfakeTokenForTestsOnly_abcdefghijklmnop";
  const HOOK = "https://discord.com/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl";
  const off = { ALERT_TELEGRAM_BOT_TOKEN: "", ALERT_TELEGRAM_CHAT_ID: "", ALERT_DISCORD_WEBHOOK_URL: "" };

  it("are optional, and empty means off", () => {
    withEnv(off);
    expect(alertChannels()).toEqual([]);
    expect(env().ALERT_TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
  it("accept a Telegram bot token with a chat id, and a Discord webhook", () => {
    withEnv({ ...off, ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "-1001234567890" });
    expect(alertChannels()).toEqual(["telegram"]);
    withEnv({ ...off, ALERT_DISCORD_WEBHOOK_URL: HOOK });
    expect(alertChannels()).toEqual(["discord"]);
    withEnv({ ...off, ALERT_DISCORD_WEBHOOK_URL: HOOK.replace("discord.com", "discordapp.com") });
    expect(alertChannels()).toEqual(["discord"]);
  });
  it("reject a token or chat id that does not look right, without showing it", () => {
    for (const bad of ["abc", "123456789", "123:short", "123456789:has spaces in it but is long enough"]) {
      withEnv({ ...off, ALERT_TELEGRAM_BOT_TOKEN: bad, ALERT_TELEGRAM_CHAT_ID: "1" });
      expect(() => env(), bad).toThrow(/ALERT_TELEGRAM_BOT_TOKEN/);
      try { env(); } catch (e) { expect(String(e)).not.toContain(bad); }
    }
    withEnv({ ...off, ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "@channel" });
    expect(() => env()).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
  });
  it("need both Telegram settings together", () => {
    withEnv({ ...off, ALERT_TELEGRAM_BOT_TOKEN: TOKEN });
    expect(() => env()).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
    withEnv({ ...off, ALERT_TELEGRAM_CHAT_ID: "123" });
    expect(() => env()).toThrow(/ALERT_TELEGRAM_BOT_TOKEN/);
  });
  it("accept only Discord's own https webhook addresses", () => {
    for (const bad of [
      HOOK.replace("https:", "http:"),
      "https://evil.example.com/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl",
      "https://discord.com.evil.example/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl",
      "https://discord.com/api/other/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl",
      `${HOOK}?wait=true`,
      "https://user@discord.com/api/webhooks/123456789012345678/fakeWebhookTokenForTestsOnly_abcdefghijkl",
    ]) {
      withEnv({ ...off, ALERT_DISCORD_WEBHOOK_URL: bad });
      expect(() => env(), bad).toThrow(/ALERT_DISCORD_WEBHOOK_URL/);
    }
  });
});
