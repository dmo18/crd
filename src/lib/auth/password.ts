import bcrypt from "bcryptjs";
import { env } from "@/lib/env";

export const MAX_PASSWORD_LENGTH = 200;

/** True only when `plain` matches the owner password. Never logs inputs. */
export async function verifyPassword(plain: string): Promise<boolean> {
  if (typeof plain !== "string" || plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return false;
  try {
    const hash = Buffer.from(env().OWNER_PASSWORD_HASH_B64, "base64").toString("utf8");
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
