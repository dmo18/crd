import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieLooksValid } from "@/lib/auth/seal";
import { env } from "@/lib/env";
import { REQUEST_ID_HEADER } from "@/lib/log";

const HOST_PATTERN = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;

export type RedirectSettings = { appOrigin?: string; nodeEnv: string };

/**
 * Where to send a visitor who is not signed in.
 *
 * Behind Apache the Host header is 127.0.0.1:3210, so request.url names the
 * internal address. With APP_ORIGIN set, the public address is used. Without
 * it, in development, the forwarded host and protocol are used (only when they
 * look valid). In production without APP_ORIGIN, request.url is used: Next.js
 * rewrites a redirect to the same host as the request into a relative
 * Location ("/login"), so the browser stays on the address it is using.
 */
export function loginUrl(request: { url: string; headers: Headers }, settings: RedirectSettings): URL {
  if (settings.appOrigin) return new URL("/login", settings.appOrigin);
  if (settings.nodeEnv !== "production") {
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (host && HOST_PATTERN.test(host) && (proto === "http" || proto === "https")) {
      try {
        return new URL("/login", `${proto}://${host}`);
      } catch {
        // Fall through to the request address.
      }
    }
  }
  return new URL("/login", request.url);
}

/** Pages anyone may open: sign-in, first-run setup (it shows itself only while no password exists) and the health check. */
export function isPublicPath(pathname: string): boolean {
  return /^\/(?:login|setup|api\/health)(?:\/|$)/.test(pathname);
}

/**
 * The page's Content Security Policy. Scripts run only with this request's
 * nonce (Next.js adds it to its own scripts while rendering) or when loaded
 * by such a script. Styles keep 'unsafe-inline': React style attributes
 * cannot carry a nonce, and the risk from styles is small.
 */
export function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Runs before every page and API request.
 *
 * 1. Turns away anyone without a genuine owner session before the request
 *    body is read, so strangers cannot make the server hold large uploads.
 *    The cookie is unsealed and its signature checked here (the proxy runs in
 *    Node.js, so iron-session works); the session version is still checked
 *    against the database by requireOwner and guardApi.
 * 2. Sets a fresh CSP nonce for every page.
 * 3. Gives every request a fresh id (x-request-id) for the log.
 */
export async function proxy(request: NextRequest) {
  const e = env();
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, e.NODE_ENV === "development");

  if (!isPublicPath(request.nextUrl.pathname)) {
    const signedIn = await sessionCookieLooksValid(request.cookies.get(SESSION_COOKIE)?.value, e.SESSION_SECRET);
    if (!signedIn) {
      const denied = request.nextUrl.pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Please sign in." }, { status: 401 })
        : NextResponse.redirect(loginUrl(request, { appOrigin: e.APP_ORIGIN, nodeEnv: e.NODE_ENV }));
      denied.headers.set("Content-Security-Policy", csp);
      return denied;
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Always replaced, so a visitor cannot choose the id their log lines carry.
  requestHeaders.set(REQUEST_ID_HEADER, crypto.randomUUID());
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static files. Sign-in, setup and the health check
    // pass through for the CSP header only (see isPublicPath).
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icons/).*)",
  ],
};
