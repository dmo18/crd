// Safe, fake settings for tests. No real secrets, no real AI calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-test-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: dir,
  SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
  // Hash of the test password "test-password", base64 encoded like the real setting.
  OWNER_PASSWORD_HASH_B64: Buffer.from(bcrypt.hashSync("test-password", 4)).toString("base64"),
  RECOGNITION_MODE: "sample",
  ANTHROPIC_API_KEY: "",
  // Alerts off, so no test can reach Telegram or Discord.
  ALERT_TELEGRAM_BOT_TOKEN: "",
  ALERT_TELEGRAM_CHAT_ID: "",
  ALERT_DISCORD_WEBHOOK_URL: "",
});
