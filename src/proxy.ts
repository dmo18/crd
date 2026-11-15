import { NextResponse, type NextRequest } from "next/server";

// Fast, optimistic check only: is there a session cookie at all?
// The real check (unsealing the cookie) happens in requireOwner and guardApi.
export function proxy(request: NextRequest) {
  if (request.cookies.has("crd_session")) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!login|_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icons/).*)",
  ],
};
