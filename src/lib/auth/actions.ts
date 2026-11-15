"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import type { AttemptKind } from "@/db/schema";
import { env } from "@/lib/env";
import { isOwner } from "./guard";
import {
  changeOwnerPassword, checkOwnerPassword, createOwnerPassword, hashNewPassword, MAX_PASSWORD_LENGTH,
  newPasswordProblem, passwordSource, setupAvailable, setupCodeMatches,
} from "./password";
import { beginAttempt, clientIp, markAttemptSucceeded, type BeginResult } from "./rate-limit";
import { getSession } from "./session";

export type LoginState = { error: string | null };
export type SetupState = { error: string | null };
export type ChangePasswordState = { error: string | null; done: boolean };

const WRONG_PASSWORD = "Wrong password. Try again.";
const NO_PASSWORD_YET = "Finish setup first. No password has been set yet.";
const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";
const TOO_MANY_LONG = "Too many tries. Wait 24 hours and try again.";
const WRONG_CODE = "That setup code is not right. Copy it again from the server settings.";
const SETUP_DONE = "Setup is already finished. Sign in with your password.";

function tooMany(attempt: Extract<BeginResult, { ok: false }>): string {
  return attempt.lock === "long" ? TOO_MANY_LONG : TOO_MANY;
}

/** Checks the limits and books a failed attempt for this visitor before any secret is checked. */
async function book(kind: AttemptKind): Promise<BeginResult> {
  const ip = clientIp(await headers(), env().TRUST_PROXY_HOPS);
  return beginAttempt(ip, getDb(), new Date(), kind);
}

async function signIn(version: number): Promise<void> {
  const session = await getSession();
  session.owner = true;
  session.since = Date.now();
  session.version = version;
  await session.save();
}

const text = z.string().max(MAX_PASSWORD_LENGTH);

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  // Booked as a failure first; only a correct password turns it into a success.
  const attempt = await book("login");
  if (!attempt.ok) return { error: tooMany(attempt) };
  if (passwordSource().source === "none") return { error: NO_PASSWORD_YET };

  const version = await checkOwnerPassword(formData.get("password"));
  if (version === null) return { error: WRONG_PASSWORD };
  markAttemptSucceeded(attempt.id);
  await signIn(version);
  redirect("/");
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}

const setupForm = z.object({ code: text, password: text, confirm: text });

/** First-run setup: the setup code unlocks setting the owner password once. */
export async function setupOwner(_prev: SetupState, formData: FormData): Promise<SetupState> {
  if (!setupAvailable()) return { error: SETUP_DONE };
  const parsed = setupForm.safeParse({
    code: formData.get("code"), password: formData.get("password"), confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { error: "Fill in every box." };
  // Checking the new password's shape reveals nothing secret, so it comes first.
  const problem = newPasswordProblem(parsed.data);
  if (problem) return { error: problem };

  const attempt = await book("setup");
  if (!attempt.ok) return { error: tooMany(attempt) };
  const expected = env().SETUP_CODE;
  if (!expected || !setupCodeMatches(parsed.data.code, expected)) return { error: WRONG_CODE };

  const hash = await hashNewPassword(parsed.data.password);
  const version = createOwnerPassword(hash);
  if (version === null) return { error: SETUP_DONE };
  markAttemptSucceeded(attempt.id);
  await signIn(version);
  redirect("/");
}

const changeForm = z.object({ current: text, password: text, confirm: text });

/**
 * Owner only. Changes a password kept in the database and signs out every
 * other device. This device stays signed in with the new version.
 */
export async function changePassword(_prev: ChangePasswordState, formData: FormData): Promise<ChangePasswordState> {
  if (!(await isOwner())) return { error: "Please sign in again.", done: false };
  const source = passwordSource();
  if (source.source !== "db") return { error: "This password is set in the server settings and cannot be changed here.", done: false };
  const parsed = changeForm.safeParse({
    current: formData.get("current"), password: formData.get("password"), confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { error: "Fill in every box.", done: false };
  const problem = newPasswordProblem(parsed.data);
  if (problem) return { error: problem, done: false };

  const attempt = await book("change_password");
  if (!attempt.ok) return { error: tooMany(attempt), done: false };
  const currentOk = parsed.data.current.length > 0 && (await bcrypt.compare(parsed.data.current, source.hash));
  if (!currentOk) return { error: "Your current password is not right.", done: false };

  const version = changeOwnerPassword(source.version, await hashNewPassword(parsed.data.password));
  if (version === null) return { error: "The password was changed somewhere else. Sign in again and retry.", done: false };
  markAttemptSucceeded(attempt.id);
  await signIn(version);
  return { error: null, done: true };
}
