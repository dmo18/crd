"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "./password";
import { clientIp, isRateLimited, recordAttempt } from "./rate-limit";
import { getSession } from "./session";

export type LoginState = { error: string | null };

const WRONG_PASSWORD = "Wrong password. Try again.";
const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = clientIp(await headers());
  if (isRateLimited(ip)) return { error: TOO_MANY };

  const value = formData.get("password");
  const ok = typeof value === "string" && (await verifyPassword(value));
  recordAttempt(ip, ok);
  if (!ok) return { error: WRONG_PASSWORD };

  const session = await getSession();
  session.owner = true;
  session.since = Date.now();
  await session.save();
  redirect("/");
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}
