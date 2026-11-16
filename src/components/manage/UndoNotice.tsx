"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime } from "@/components/activity/LocalTime";
import { Button, Notice } from "@/components/ui";
import { undoBulkAction } from "@/lib/items/bulk-actions";

export type UndoOffer = { id: number; summary: string; madeAt: number };

/**
 * Shows the latest change that can still be undone, with its own summary and
 * date, and asks before undoing it. When an older change becomes the latest,
 * it shows up here with its own words and needs its own confirm.
 */
export function UndoNotice({ offer, message }: { offer: UndoOffer | null; message: string | null }) {
  const router = useRouter();
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);

  async function undo(o: UndoOffer) {
    setBusy(true);
    try {
      const r = await undoBulkAction(o.id);
      if ("error" in r) setResult({ text: r.error, bad: true });
      else setResult({ text: `Put back ${r.restored} ${r.restored === 1 ? "item" : "items"}.${r.skipped > 0 ? ` Skipped ${r.skipped} (edited or removed since).` : ""}`, bad: false });
    } catch {
      setResult({ text: "Could not reach the server. Nothing was undone.", bad: true });
    } finally {
      setBusy(false);
      setAsking(null);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 pb-4">
      {message ? <Notice tone="accent"><span role="status">{message}</span></Notice> : null}
      {result ? <Notice tone={result.bad ? "danger" : "accent"}><span role="status">{result.text}</span></Notice> : null}
      {offer ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
          <p className="text-sm"><span className="font-semibold">Latest change:</span> {offer.summary}, made <LocalTime ms={offer.madeAt} />.</p>
          {asking === offer.id ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm font-semibold">Undo: {offer.summary}, made <LocalTime ms={offer.madeAt} />?</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" disabled={busy} onClick={() => void undo(offer)}>{busy ? "Undoing" : "Yes, undo it"}</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(null)}>Keep it</Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => { setResult(null); setAsking(offer.id); }}>Undo this change</Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
