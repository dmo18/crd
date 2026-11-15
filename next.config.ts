import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// No third-party scripts, styles or images are used, so everything is limited
// to this site. Inline script and style are needed by the framework itself.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
  // MAX_BODY_BYTES in src/app/api/scans/route.ts.
  experimental: {
    proxyClientMaxBodySize: "64mb",
    serverActions: { allowedOrigins: appOriginHosts() },
  },
  serverExternalPackages: ["better-sqlite3", "sharp", "tesseract.js", "@tesseract.js-data/eng"],
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
