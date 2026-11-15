import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Card Vault", template: "%s · Card Vault" },
  description: "Scan, index and value a sports card collection.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1210" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page is rendered per request, so each one gets the CSP nonce set in
  // src/proxy.ts. A page built ahead of time would have scripts without it.
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
