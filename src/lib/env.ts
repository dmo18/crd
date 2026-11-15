import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
}

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
      return url.origin;
    }, z.string())
    .pipe(z.url({ protocol: /^https?$/ }))
    .refine((v) => URL.canParse(v) && new URL(v).origin === v, "APP_ORIGIN must be only the address, like https://cards.example.com, with no slash at the end")
    .optional(),
  /** How many proxies in front of the app add to X-Forwarded-For (0 to 5). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).superRefine((v, ctx) => {
  // http is accepted in production only for this computer itself (a local
  // test of the built app), where browsers still treat the page as secure.
  if (v.NODE_ENV === "production" && v.APP_ORIGIN && !v.APP_ORIGIN.startsWith("https://") && !isLocalHost(v.APP_ORIGIN)) {
    ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN must start with https:// in production" });
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server settings. Throws a clear error when something is missing. */
export function env(): Env {
  if (cached) return cached;
  const raw = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "APP_ORIGIN", "TRUST_PROXY_HOPS", "OWNER_PASSWORD_HASH_B64", "SETUP_CODE"]) {
    if (raw[name]?.trim() === "") delete raw[name];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
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
