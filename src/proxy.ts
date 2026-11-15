import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

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

// Fast, optimistic check only: is there a session cookie at all?
// The real check (unsealing the cookie) happens in requireOwner and guardApi.
export function proxy(request: NextRequest) {
  if (request.cookies.has("crd_session")) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  const e = env();
  return NextResponse.redirect(loginUrl(request, { appOrigin: e.APP_ORIGIN, nodeEnv: e.NODE_ENV }));
}

export const config = {
  matcher: [
    // Everything except the sign-in page, the public health check and static files.
    "/((?!login|api/health|_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icons/).*)",
  ],
};
