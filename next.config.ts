import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// The Content Security Policy is set per request in src/proxy.ts, because it
// carries a fresh script nonce each time.
const securityHeaders = [
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

/**
 * Host of the public address (APP_ORIGIN), for the server action origin check.
 * Next.js compares the browser's Origin with X-Forwarded-Host (or Host). Apache
 * forwards the public host in X-Forwarded-Host, so this is a safety net in case
 * a proxy in front ever stops doing that. The value itself is checked by
 * src/lib/env.ts when the app starts; here a bad value is simply ignored.
 */
function appOriginHosts(): string[] {
  const raw = process.env.APP_ORIGIN?.trim();
  if (!raw) return [];
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? [url.host.toLowerCase()] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  // Private, single-owner app: every page is rendered per request, so the
  // newer static-shell caching features are deliberately left off.
  poweredByHeader: false,
  // Scans upload several photos in one request. Must stay in step with
  // MAX_BODY_BYTES in src/app/api/scans/route.ts. Only signed-in requests get
  // this far: src/proxy.ts checks the session cookie's signature first.
  experimental: {
    proxyClientMaxBodySize: "64mb",
    serverActions: { allowedOrigins: appOriginHosts() },
  },
  serverExternalPackages: ["better-sqlite3", "sharp"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
