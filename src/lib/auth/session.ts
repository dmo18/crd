import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "crd_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export type SessionData = { owner?: true; since?: number };

export function sessionOptions(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE,
    password: env().SESSION_SECRET,
    ttl: SESSION_MAX_AGE,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: env().NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}
