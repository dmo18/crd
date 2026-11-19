"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useScanStore } from "@/components/items/ScanQueueProvider";
import { NO_STATUS, SAVED_EVENT } from "@/components/items/scan-store";
import { nextStatusAskMs, parseCounts, pillText } from "./scan-status-poll";

/**
 * The small "being read" pill above the tab bar. It is fixed in place, so it
 * never moves the tab bar. It asks the server when a page loads, when the
 * scan screen saves a photo and when the tab comes back, and then every 5
 * seconds only while scans are being read and the tab is on screen. While
 * the scan list is already asking (it holds scans being read), the pill
 * shows the counts from that same answer and has no timer of its own.
 */
export function ScanStatus() {
  const pathname = usePathname();
  const store = useScanStore();
  const shared = useSyncExternalStore(store.subscribe, store.getStatus, () => NO_STATUS);
  const { counts, polling, signedOut } = shared;
  const busy = useRef(false);

  // `always`: ask even while the scan list is asking (only when a photo was just saved).
  const ask = useCallback(async (always = false) => {
    if (busy.current || document.hidden) return;
    if (!always && store.getStatus().polling) return;
    busy.current = true;
    try {
      const res = await fetch("/api/scans/status", { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      // Signed out: hide the pill, which also stops its timer.
      if (res.status === 401) store.setCounts(null);
      if (!res.ok) return;
      const next = parseCounts(await res.json());
      if (next) store.setCounts(next);
    } catch {
      // A network blip: the next ask will fix it. Keep showing the last numbers.
    } finally {
      busy.current = false;
    }
  }, [store]);

  // Once per page load (the layout stays mounted, so also when the owner moves to another page).
  useEffect(() => {
    const t = window.setTimeout(() => void ask(), 0);
    return () => window.clearTimeout(t);
  }, [ask, pathname]);

  // When the scan screen saves a photo, and when the tab comes back to the screen.
  useEffect(() => {
    const onSaved = () => void ask(true);
    const onVisible = () => {
      if (!document.hidden) void ask();
    };
    window.addEventListener(SAVED_EVENT, onSaved);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(SAVED_EVENT, onSaved);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ask]);

  // Timer: only while something is being read; stops at 0 and while the tab is hidden.
  const reading = counts?.reading ?? 0;
  useEffect(() => {
    const ms = nextStatusAskMs(reading, false, { polling, signedOut });
    if (ms === null) return;
    const id = window.setInterval(() => void ask(), ms);
    return () => window.clearInterval(id);
  }, [reading, ask, polling, signedOut]);

  const text = pillText(counts);
  if (!text) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex justify-center px-4">
      <Link
        href="/scans"
        className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-semibold text-text shadow-lg"
      >
        {text.reading ? <span>{text.reading}</span> : null}
        {text.failed ? <span className="rounded-full bg-danger-soft px-2 py-0.5 text-danger">{text.failed}</span> : null}
      </Link>
    </div>
  );
}
