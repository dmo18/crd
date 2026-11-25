"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { shrinkPhoto } from "@/components/capture/shrink";
import { Button, LinkButton, Notice } from "@/components/ui";
import { MAX_BATCH_PHOTOS } from "@/lib/scans/batch-limits";
import { batchProgress, batchRoom, PAIRING_LINE, planBatch, progressLine, unsentKeys, type BatchLayout } from "./batch-plan";
import { useScanQueue } from "./ScanQueueProvider";

const BUTTON_LABEL = "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-base font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

const LAYOUTS: { value: BatchLayout; title: string; text: string }[] = [
  { value: "fronts", title: "Fronts only", text: "Each photo is one card." },
  { value: "pairs", title: "Front, back, front, back (in order)", text: "Pick each card's front, then its back, then the next card." },
];

/**
 * "Many photos, one card each": the owner picks up to 60 photos at once.
 * Each card becomes its own scan in the normal list, with one upload id, so
 * Scan activity can report on the upload. Sending, retries and "never sent
 * twice" are the list's own (scan-store).
 */
export function BatchUpload({ hint, locationId }: { hint: string; locationId: string }) {
  const { state, store } = useScanQueue();
  const [layout, setLayout] = useState<BatchLayout>("fronts");
  const [files, setFiles] = useState<File[]>([]);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);

  const plan = useMemo(() => (files.length === 0 ? null : planBatch(files, layout, batchRoom(state))), [files, layout, state]);
  // Small local previews of the picked photos, so the owner can check the order.
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const progress = batchProgress(state);

  async function send() {
    if (!plan?.ok || busy.current) return;
    busy.current = true;
    setNote(null);
    const batchKey = crypto.randomUUID();
    const cards = plan.cards;
    let added = 0;
    try {
      for (const [i, card] of cards.entries()) {
        setPreparing({ done: i, total: cards.length });
        const front = await shrinkPhoto(card.front);
        const back = card.back ? await shrinkPhoto(card.back) : undefined;
        const ok = store.enqueue({ mode: "single", hint, locationId, front, back, source: [], batchKey }, front, `Card ${i + 1} of ${cards.length}`);
        if (!ok) break;
        added += 1;
      }
    } finally {
      setPreparing(null);
      busy.current = false;
    }
    setFiles([]);
    if (added < cards.length) {
      setNote(`${added} of ${cards.length} cards were added. The list on this page is full. Pick the rest again once these are read.`);
    }
  }

  function resend(batch: string) {
    for (const key of unsentKeys(store.getState(), batch)) void store.retry(key);
  }

  const cardCount = plan?.ok ? plan.cards.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-base font-semibold">How are the photos laid out?</legend>
        {LAYOUTS.map((l) => (
          <label key={l.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-border bg-surface p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
            <input type="radio" name="batch-layout" value={l.value} checked={layout === l.value} onChange={() => setLayout(l.value)}
              disabled={preparing !== null} className="mt-1 size-5 shrink-0 accent-accent" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold">{l.title}</span>
              <span className="text-sm text-muted">{l.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className={`${BUTTON_LABEL} border border-border bg-surface-2 text-text ${preparing ? "pointer-events-none opacity-50" : ""}`}>
        <span>{files.length > 0 ? "Pick other photos" : `Choose photos (up to ${MAX_BATCH_PHOTOS})`}</span>
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="sr-only"
          disabled={preparing !== null}
          onChange={(e) => {
            const copy = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            setNote(null);
            setFiles(copy);
          }}
        />
      </label>

      {plan && !plan.ok ? <div role="alert"><Notice tone="danger">{plan.error}</Notice></div> : null}

      {plan?.ok ? (
        <section aria-labelledby="batch-check" className="flex flex-col gap-3">
          <h3 id="batch-check" className="font-semibold">
            {files.length} {files.length === 1 ? "photo" : "photos"}, {cardCount} {cardCount === 1 ? "card" : "cards"}
          </h3>
          {layout === "pairs" ? <p className="text-sm text-muted">Check that each card shows its front first, then its back. {PAIRING_LINE}</p> : null}
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {plan.cards.map((card, i) => {
              const at = layout === "pairs" ? i * 2 : i;
              return (
                <li key={at} className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-2">
                  <span className="text-xs font-semibold">Card {i + 1}</span>
                  <div className="flex gap-1">
                    {/* Local previews of the picked photos; not server images. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={previews[at]} alt={`Card ${i + 1} front`} loading="lazy" className="h-16 min-w-0 flex-1 rounded-md bg-surface-2 object-contain" />
                    {card.back ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previews[at + 1]} alt={`Card ${i + 1} back`} loading="lazy" className="h-16 min-w-0 flex-1 rounded-md bg-surface-2 object-contain" />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <Button type="button" onClick={() => void send()} disabled={preparing !== null}>
            {preparing ? `Getting photos ready: ${preparing.done} of ${preparing.total}` : `Send ${cardCount} ${cardCount === 1 ? "card" : "cards"}`}
          </Button>
        </section>
      ) : null}

      {note ? <Notice tone="warn">{note}</Notice> : null}

      {progress.map((p) => (
        <div key={p.batch} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
          <p className="font-semibold" role="status">{progressLine(p)}</p>
          {p.notSent > 0 ? (
            <>
              <p className="text-sm text-danger">
                {p.notSent} not sent. Check your connection. The ones already sent are safe and will not be sent twice.
              </p>
              <Button type="button" variant="secondary" onClick={() => resend(p.batch)}>Send the rest again</Button>
            </>
          ) : null}
          {p.sent > 0 ? <LinkButton href="/scans" variant="secondary">See the report</LinkButton> : null}
        </div>
      ))}
    </div>
  );
}
