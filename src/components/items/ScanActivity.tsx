"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { nextStatusAskMs } from "@/components/nav/scan-status-poll";
import { Badge, Button, Card } from "@/components/ui";
import type { ScanView } from "@/lib/scans/view";
import { waitingText } from "./scan-queue";
import { SAVED_EVENT } from "./scan-store";

/** The words for one scan. */
export function scanStatusWords(scan: Pick<ScanView, "status" | "error">): string {
  switch (scan.status) {
    case "queued": return "Waiting";
    case "processing": return "Being read";
    case "done": return "Done";
    case "failed": return `Did not work${scan.error ? `: ${scan.error}` : ""}`;
  }
}

/** True while any scan is waiting or being read, so the page keeps refreshing itself. */
export function anyUnfinished(list: Pick<ScanView, "status">[]): number {
  return list.filter((s) => s.status === "queued" || s.status === "processing").length;
}

/** The list on /scans. Refreshes itself every 5 seconds while anything is waiting or being read and the tab is visible. */
export function ScanActivity({ scans, photos }: { scans: ScanView[]; photos: Record<number, string> }) {
  const router = useRouter();
  const open = anyUnfinished(scans);

  useEffect(() => {
    const ms = nextStatusAskMs(open, false);
    if (ms === null) return;
    const id = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [open, router]);

  return (
    <ul className="flex flex-col gap-3">
      {scans.map((scan) => (
        <li key={scan.id}>
          <ScanRow scan={scan} photo={photos[scan.id] ?? null} onChanged={() => router.refresh()} />
        </li>
      ))}
    </ul>
  );
}

function ScanRow({ scan, photo, onChanged }: { scan: ScanView; photo: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const wait = waitingText(scan);

  async function retry() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/scans/${scan.id}/retry`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        // Tell the pill, then show the new state.
        window.dispatchEvent(new Event(SAVED_EVENT));
        onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setProblem(typeof data?.error === "string" && data.error.length <= 200 ? data.error : "Could not try again. Please try later.");
      }
    } catch {
      setProblem("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex gap-3 p-3">
      {photo ? (
        // Photos come from our own /api/images route, already resized.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/images/${photo}`} alt={`Photo for scan ${scan.id}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-xs text-muted">Scan {scan.id}</p>
        <p className={`text-sm font-semibold break-words ${scan.status === "failed" ? "text-danger" : ""}`}>
          {scanStatusWords(scan)}
        </p>
        {wait ? <p className="text-sm text-muted">{wait}</p> : null}
        {scan.status === "done" && scan.items.length === 0 ? <p className="text-sm text-muted">No card found.</p> : null}
        {scan.status === "done" && scan.items.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {scan.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/items/${item.id}`} className="inline-flex min-h-11 items-center text-sm text-accent underline break-words">
                  {item.title}
                </Link>
                {item.status === "needs_review" ? (
                  <Link href="/review" aria-label={`Check ${item.title} in Review`} className="inline-flex min-h-11 items-center">
                    <Badge tone="warn">Check</Badge>
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {scan.status === "failed" ? (
          <div className="flex flex-col gap-1">
            <Button variant="secondary" onClick={() => void retry()} disabled={busy} aria-label={`Retry scan ${scan.id}`}>
              {busy ? "Trying again" : "Retry"}
            </Button>
            {problem ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
