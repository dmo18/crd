"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "./password";
import { beginAttempt, clientIp, markAttemptSucceeded } from "./rate-limit";
import { env } from "@/lib/env";
import { getSession } from "./session";

export type LoginState = { error: string | null };

const WRONG_PASSWORD = "Wrong password. Try again.";
const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";
const TOO_MANY_LONG = "Too many tries. Wait 24 hours and try again.";

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = clientIp(await headers(), env().TRUST_PROXY_HOPS);
  // Booked as a failure first; only a correct password turns it into a success.
  const attempt = beginAttempt(ip);
  if (!attempt.ok) return { error: attempt.lock === "long" ? TOO_MANY_LONG : TOO_MANY };

  const value = formData.get("password");
  const ok = typeof value === "string" && (await verifyPassword(value));
  if (!ok) return { error: WRONG_PASSWORD };
  markAttemptSucceeded(attempt.id);

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
