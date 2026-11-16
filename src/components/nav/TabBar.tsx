"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const TABS: { href: string; label: string; icon: ReactNode; emphasis?: boolean }[] = [
  { href: "/", label: "Home", icon: svg(<path d="M3 11l9-8 9 8M5 10v10h14V10" />) },
  { href: "/scan", label: "Scan", emphasis: true, icon: svg(<><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" /><circle cx="12" cy="12" r="3" /></>) },
  { href: "/review", label: "Review", icon: svg(<path d="M5 12l5 5L20 7" />) },
  { href: "/items", label: "Inventory", icon: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /></>) },
  { href: "/more", label: "More", icon: svg(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>) },
];

/** Pages reached from a tab that live outside its path (Manage records belongs to Inventory). */
const ALSO: Record<string, string[]> = { "/items": ["/manage"] };

function under(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return under(pathname, href) || (ALSO[href] ?? []).some((h) => under(pathname, h));
}

export function TabBar({ reviewCount = 0 }: { reviewCount?: number }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-xl items-stretch justify-around px-1">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          const waiting = tab.href === "/review" ? reviewCount : 0;
          return (
            <li key={tab.href} className="flex flex-1 justify-center">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={
                  tab.emphasis
                    ? "my-1 flex min-h-12 min-w-14 flex-col items-center justify-center gap-0.5 rounded-xl bg-accent px-3 text-xs font-semibold text-accent-text"
                    : `flex min-h-14 min-w-14 flex-col items-center justify-center gap-0.5 px-2 text-xs font-medium ${active ? "text-accent" : "text-muted"}`
                }
              >
                <span className="relative">
                  {tab.icon}
                  {waiting > 0 ? (
                    <span aria-hidden="true" className="absolute -top-1.5 left-3.5 min-w-5 rounded-full bg-accent px-1 text-center text-[11px] leading-5 font-bold text-accent-text">
                      {waiting > 99 ? "99+" : waiting}
                    </span>
                  ) : null}
                </span>
                <span>{tab.label}</span>
                {waiting > 0 ? <span className="sr-only">, {waiting > 99 ? "more than 99" : waiting} waiting</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
