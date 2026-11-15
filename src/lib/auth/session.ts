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
      // Secure stays on in production even behind Cloudways (Nginx, Apache,
      // then plain HTTP to Node on 127.0.0.1). The flag is only an instruction
      // to the browser: send this cookie over HTTPS only. The browser talks
      // HTTPS to Cloudways, so it keeps sending the cookie; Node seeing HTTP
      // does not matter, because iron-session sets the flag without checking
      // the connection.
      secure: env().NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}
