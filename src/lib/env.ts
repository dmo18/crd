import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Telegram bot token: the bot's number, a colon, then about 35 letters, digits, _ or -. */
export const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
/** A chat id is a number (negative for groups and channels). */
export const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;
/** Only Discord's own webhook addresses, over https. */
export const DISCORD_WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATA_DIR: z.string().min(1).default("./data"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /**
   * Owner password (bcrypt hash, base64). Optional: without it the password
   * is set once in the app at /setup and kept in the database. When set, it wins.
   */
  OWNER_PASSWORD_HASH_B64: z.string().min(1).optional(),
  /** One-time code that unlocks /setup while no password exists anywhere. */
  SETUP_CODE: z.string().min(16, "SETUP_CODE must be at least 16 characters").max(200).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  RECOGNITION_MODE: z.enum(["auto", "free", "sample", "anthropic"]).default("auto"),
  /** Public address of the app, e.g. https://cards.example.com (no trailing slash). */
  // Hosting panels may hand over the address with a path or a trailing
  // slash; keep only the origin (scheme, host and port).
  APP_ORIGIN: z
    .preprocess((v) => {
      if (typeof v !== "string" || !URL.canParse(v.trim())) return v;
      const url = new URL(v.trim());
      // Coolify writes the app's internal port (3000) into its generated
      // address; visitors never use it, so it is dropped for https.
      if (url.protocol === "https:" && url.port === "3000") url.port = "";
      // TLS is terminated in front of the app (Cloudflare or Traefik); the app
      // never serves plain HTTP to visitors. So in production an http address
      // that is not this computer is upgraded to https. Coolify behind a
      // Cloudflare Tunnel generates http:// addresses.
      if (process.env.NODE_ENV === "production" && url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
        url.protocol = "https:";
        if (url.port === "3000" || url.port === "80") url.port = "";
      }
      return url.origin;
    }, z.string())
    .pipe(z.url({ protocol: /^https?$/ }))
    .refine((v) => URL.canParse(v) && new URL(v).origin === v, "APP_ORIGIN must be only the address, like https://cards.example.com, with no slash at the end")
    .optional(),
  /** How many proxies in front of the app add to X-Forwarded-For (0 to 5). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Optional name of a request header that holds the visitor's address, for
   * example cf-connecting-ip. When set, sign-in limits read ONLY this header
   * and TRUST_PROXY_HOPS is ignored. Set it only when the server can be reached
   * solely through the proxy that writes it (for example a Cloudflare Tunnel
   * with no open ports); otherwise anyone can fake it. Empty means off.
   */
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,64}$/i, "CLIENT_IP_HEADER must be a header name like cf-connecting-ip")
    .transform((v) => v.toLowerCase())
    .optional(),
  /** Optional alerts to Telegram: the bot's token from @BotFather and the chat to post in. */
  ALERT_TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .regex(TELEGRAM_TOKEN, "ALERT_TELEGRAM_BOT_TOKEN must be the token @BotFather gave you: digits, a colon, then letters and digits")
    .optional(),
  ALERT_TELEGRAM_CHAT_ID: z
    .string()
    .trim()
    .regex(TELEGRAM_CHAT_ID, "ALERT_TELEGRAM_CHAT_ID must be a number like 123456789 (or -100... for a group)")
    .optional(),
  /** Optional alerts to Discord: a channel webhook address. */
  ALERT_DISCORD_WEBHOOK_URL: z
    .string()
    .trim()
    .regex(DISCORD_WEBHOOK, "ALERT_DISCORD_WEBHOOK_URL must start with https://discord.com/api/webhooks/")
    .optional(),
}).superRefine((v, ctx) => {
  if (Boolean(v.ALERT_TELEGRAM_BOT_TOKEN) !== Boolean(v.ALERT_TELEGRAM_CHAT_ID)) {
    ctx.addIssue({
      code: "custom",
      path: [v.ALERT_TELEGRAM_BOT_TOKEN ? "ALERT_TELEGRAM_CHAT_ID" : "ALERT_TELEGRAM_BOT_TOKEN"],
      message: "Telegram alerts need both ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID",
    });
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server settings. Throws a clear error when something is missing. */
export function env(): Env {
  if (cached) return cached;
  const raw = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "APP_ORIGIN", "TRUST_PROXY_HOPS", "CLIENT_IP_HEADER", "OWNER_PASSWORD_HASH_B64", "SETUP_CODE",
    "ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_DISCORD_WEBHOOK_URL"]) {
    if (raw[name]?.trim() === "") delete raw[name];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Only names and rules, never the values given.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server settings (see .env.example): ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}

/**
 * Which recognizer to use. The owner chose free reading with no keys, so
 * "auto" means free. Paid AI runs only when explicitly set to "anthropic".
 */
export function recognitionMode(): "free" | "sample" | "anthropic" {
  const e = env();
  if (e.RECOGNITION_MODE === "sample") return "sample";
  if (e.RECOGNITION_MODE === "anthropic") return "anthropic";
  return "free";
}

/** Host (with port, if any) of APP_ORIGIN, lowercased, or null when unset. */
export function appOriginHost(e: Pick<Env, "APP_ORIGIN"> = env()): string | null {
  return e.APP_ORIGIN ? new URL(e.APP_ORIGIN).host.toLowerCase() : null;
}

export type AlertChannel = "telegram" | "discord";

/** Which alert channels are set up. Never the values themselves. */
export function alertChannels(e: Env = env()): AlertChannel[] {
  const out: AlertChannel[] = [];
  if (e.ALERT_TELEGRAM_BOT_TOKEN && e.ALERT_TELEGRAM_CHAT_ID) out.push("telegram");
  if (e.ALERT_DISCORD_WEBHOOK_URL) out.push("discord");
  return out;
}
