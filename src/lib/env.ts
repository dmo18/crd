import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATA_DIR: z.string().min(1).default("./data"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  OWNER_PASSWORD_HASH_B64: z.string().min(1, "OWNER_PASSWORD_HASH_B64 is required"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  RECOGNITION_MODE: z.enum(["auto", "sample", "anthropic"]).default("auto"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server settings. Throws a clear error when something is missing. */
export function env(): Env {
  if (cached) return cached;
  const raw = { ...process.env };
  if (raw.ANTHROPIC_API_KEY === "") delete raw.ANTHROPIC_API_KEY;
  if (raw.ANTHROPIC_MODEL === "") delete raw.ANTHROPIC_MODEL;
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

/** Which recognizer to use: real AI only when asked for or when a key exists. */
export function recognitionMode(): "sample" | "anthropic" {
  const e = env();
  if (e.RECOGNITION_MODE === "sample") return "sample";
  if (e.RECOGNITION_MODE === "anthropic") return "anthropic";
  return e.ANTHROPIC_API_KEY ? "anthropic" : "sample";
}
