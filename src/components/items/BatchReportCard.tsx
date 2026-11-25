"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime } from "@/components/activity/LocalTime";
import { Button, LinkButton, Notice } from "@/components/ui";
import type { BatchReport } from "@/lib/scans/batch";

/** The counts line, for example "40 cards: 30 read, 8 waiting, 2 failed". */
export function batchCountsLine(r: Pick<BatchReport, "scans" | "read" | "waiting" | "failed">): string {
  const parts = [`${r.read} read`, `${r.waiting} waiting`, `${r.failed} failed`];
  return `${r.scans} ${r.scans === 1 ? "card" : "cards"}: ${parts.join(", ")}`;
}

/** What the retry answer means for the owner. */
export function retryResultLine(queued: number, gone: number): string {
  const parts: string[] = [];
  if (queued > 0) parts.push(`${queued} ${queued === 1 ? "card is" : "cards are"} being read again`);
  if (gone > 0) parts.push(`${gone} could not be tried again because ${gone === 1 ? "its photos are" : "their photos are"} gone; take ${gone === 1 ? "it" : "them"} again`);
  if (parts.length === 0) return "Nothing to try again.";
  const line = parts.join(". ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/** One "Many photos, one card each" upload on Scan activity: counts, and "Try the failed ones again". */
export function BatchReportCard({ report, skippedLine }: { report: BatchReport; skippedLine: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);

  async function retry() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/scans/batches/retry", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchKey: report.key }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => null)) as { queued?: number; gone?: number; error?: string } | null;
      if (res.ok) setResult({ text: retryResultLine(data?.queued ?? 0, data?.gone ?? 0), bad: false });
      else setResult({ text: res.status === 401 ? "Please sign in again." : data?.error ?? "Could not try again. Try later.", bad: true });
    } catch {
      setResult({ text: "Could not reach the server. Check your connection and try again.", bad: true });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <section aria-label="Many photos upload" className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
      <h2 className="font-semibold">Many photos, sent <LocalTime ms={report.startedAt} /></h2>
      <p className="text-base font-semibold tabular" role="status">{batchCountsLine(report)}</p>
      {report.waiting > 0 ? <p className="text-sm text-muted">They are read one at a time, about half a minute each. This page updates by itself.</p> : null}
      {report.inReview > 0 ? <p className="text-sm">{report.inReview} {report.inReview === 1 ? "waits" : "wait"} in Review.</p> : null}
      {skippedLine ? <Notice tone="warn">{skippedLine}</Notice> : null}
      {result ? <Notice tone={result.bad ? "danger" : "accent"}><span role="status">{result.text}</span></Notice> : null}
      <div className="flex flex-col gap-2">
        {report.retryable > 0 ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void retry()}>
            {busy ? "Trying again" : `Try the failed ones again (${report.retryable})`}
          </Button>
        ) : null}
        {report.inReview > 0 ? <LinkButton href="/review" variant="secondary">Go to Review</LinkButton> : null}
      </div>
    </section>
  );
}
