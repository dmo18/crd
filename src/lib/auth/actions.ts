"use server";

import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import type { AttemptKind } from "@/db/schema";
import { env } from "@/lib/env";
import { isOwner } from "./guard";
import {
  bumpSessionVersion, changeOwnerPassword, checkOwnerPassword, createOwnerPassword, currentSessionVersion, hashNewPassword,
  MAX_PASSWORD_LENGTH, newPasswordProblem, passwordSource, setupAvailable, setupCodeMatches,
} from "./password";
import { beginAttempt, clientIp, succeedAttempt, type BeginResult } from "./rate-limit";
import { DEVICE_COOKIE, DEVICE_MAX_AGE, newDeviceId, readDevice, sealDevice } from "./seal";
import { getSession } from "./session";

export type LoginState = { error: string | null };
export type SetupState = { error: string | null };
export type ChangePasswordState = { error: string | null; done: boolean };
export type SignOutOthersState = { error: string | null; done: boolean };

const WRONG_PASSWORD = "Wrong password. Try again.";
const NO_PASSWORD_YET = "Finish setup first. No password has been set yet.";
const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";
const TOO_MANY_LONG = "Too many tries. Wait 24 hours and try again.";
const WRONG_CODE = "That setup code is not right. Copy it again from the server settings.";
const SETUP_DONE = "Setup is already finished. Sign in with your password.";

function tooMany(attempt: Extract<BeginResult, { ok: false }>): string {
  return attempt.lock === "long" ? TOO_MANY_LONG : TOO_MANY;
}

/** The id in this browser's trusted-device cookie, when it is valid for the current password. */
async function trustedDevice(): Promise<string | null> {
  const raw = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!raw) return null;
  return readDevice(raw, env().SESSION_SECRET, currentSessionVersion());
}

/**
 * Checks the limits and books a failed attempt for this visitor before any
 * secret is checked. A browser that signed in before (trusted-device cookie)
 * has only its own limit, so strangers cannot lock the owner out.
 */
async function book(kind: AttemptKind): Promise<BeginResult> {
  const ip = clientIp(await headers(), env().TRUST_PROXY_HOPS, env().CLIENT_IP_HEADER);
  return beginAttempt(ip, getDb(), new Date(), kind, await trustedDevice());
}

/** Gives this browser a trusted-device cookie for 180 days, bound to `version`. Keeps its id when it had one. */
async function trustThisDevice(version: number): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(DEVICE_COOKIE)?.value;
  // Reuse the id even from a cookie of an older version, so the per-device limit follows the browser.
  const known = raw ? await readAnyDevice(raw) : null;
  jar.set(DEVICE_COOKIE, await sealDevice(known ?? newDeviceId(), version, env().SESSION_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    maxAge: DEVICE_MAX_AGE,
    path: "/",
  });
}

async function readAnyDevice(raw: string): Promise<string | null> {
  const version = currentSessionVersion();
  if (version === null) return null;
  // Try the current version and the one before it (a version raised just now).
  return (await readDevice(raw, env().SESSION_SECRET, version)) ?? (await readDevice(raw, env().SESSION_SECRET, version - 1));
}

async function signIn(version: number): Promise<void> {
  const session = await getSession();
  session.owner = true;
  session.since = Date.now();
  session.version = version;
  await session.save();
  await trustThisDevice(version);
}

const text = z.string().max(MAX_PASSWORD_LENGTH);

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  // Booked as a failure first; only a correct password turns it into a success.
  const attempt = await book("login");
  if (!attempt.ok) return { error: tooMany(attempt) };
  if (passwordSource().source === "none") return { error: NO_PASSWORD_YET };

  const version = await checkOwnerPassword(formData.get("password"));
  if (version === null) return { error: WRONG_PASSWORD };
  succeedAttempt(attempt.id);
  await signIn(version);
  redirect("/");
}

/** Signs out this browser. Its trusted-device cookie stays, so it is still recognized next time. */
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
  succeedAttempt(attempt.id);
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
  succeedAttempt(attempt.id);
  await signIn(version);
  return { error: null, done: true };
}

/**
 * Owner only. Signs out every other phone and computer and forgets them as
 * trusted devices, without changing the password. Works whether the password
 * is kept in the database or in OWNER_PASSWORD_HASH_B64. This device stays
 * signed in.
 */
export async function signOutOtherDevices(): Promise<SignOutOthersState> {
  if (!(await isOwner())) return { error: "Please sign in again.", done: false };
  const current = currentSessionVersion();
  if (current === null) return { error: "Please sign in again.", done: false };
  const version = bumpSessionVersion(current);
  if (version === null) return { error: "Something changed at the same time. Try again.", done: false };
  await signIn(version);
  return { error: null, done: true };
}
