"use client";

import { useEffect, useReducer, useRef } from "react";
import { shrinkPhoto } from "@/components/capture/shrink";
import { ItemRow } from "@/components/items/ItemRow";
import {
  atCap, emptyQueue, GIVE_UP_MS, MAX_PARALLEL, MAX_QUEUE, nextToSend, queueReducer, summary, summaryText,
  type QueueEntry,
} from "@/components/items/scan-queue";
import { Button, Card, LinkButton, Notice } from "@/components/ui";
import type { ScanView } from "@/lib/scans/view";

const POLL_MS = 2000;
const STATUS_LABEL = { waiting: "Waiting to send", sending: "Sending", reading: "Reading", done: "Done", failed: "Failed" } as const;
const NETWORK_ERROR = "Could not send the photo. Check your connection.";
const BUTTON_LABEL = "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-base font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

export function RapidScan({ hint, locationId }: { hint: string; locationId: string }) {
  const [state, dispatch] = useReducer(queueReducer, emptyQueue);
  const stateRef = useRef(state);
  const hintRef = useRef(hint);
  const locationRef = useRef(locationId);
  const files = useRef(new Map<number, File>());
  const previews = useRef(new Map<number, string>());
  const inFlight = useRef(new Set<number>());
  const nextKey = useRef(1);

  useEffect(() => {
    stateRef.current = state;
    hintRef.current = hint;
    locationRef.current = locationId;
  });

  function release(key: number) {
    const url = previews.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(key);
    files.current.delete(key);
  }

  useEffect(() => {
    const held = previews.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  async function upload(key: number) {
    const file = files.current.get(key);
    if (!file) {
      dispatch({ type: "failed", key, message: "This photo is no longer on the page. Take it again." });
      return;
    }
    const body = new FormData();
    body.set("mode", "single");
    body.set("front", file);
    if (hintRef.current.trim()) body.set("hint", hintRef.current.trim());
    if (locationRef.current) body.set("locationId", locationRef.current);
    try {
      const res = await fetch("/api/scans", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { scanId?: number; error?: string };
      if (res.status === 201 && typeof data.scanId === "number") {
        dispatch({ type: "uploaded", key, scanId: data.scanId, at: Date.now() });
      } else {
        dispatch({ type: "failed", key, message: data.error ?? "Something went wrong. Please try again." });
      }
    } catch {
      dispatch({ type: "failed", key, message: NETWORK_ERROR });
    } finally {
      inFlight.current.delete(key);
    }
  }

  // Start waiting photos whenever a slot is free.
  useEffect(() => {
    for (const key of nextToSend(state, MAX_PARALLEL)) {
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      dispatch({ type: "sending", key });
      void upload(key);
    }
    // upload only uses refs and dispatch, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // One timer for all unfinished scans.
  const polling = state.entries.some((e) => e.status === "sending" || e.status === "reading");
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const timer = setInterval(() => {
      for (const e of stateRef.current.entries) {
        if (e.status !== "reading" || e.scanId === null) continue;
        if (Date.now() - (e.uploadedAt ?? Date.now()) > GIVE_UP_MS) {
          dispatch({ type: "timeout", key: e.key });
          continue;
        }
        void (async () => {
          try {
            const res = await fetch(`/api/scans/${e.scanId}`, { cache: "no-store" });
            if (stopped || !res.ok) return;
            const scan = (await res.json()) as ScanView;
            if (stopped) return;
            dispatch({ type: "update", scan });
            if (scan.status === "done") release(e.key);
          } catch {
            // A short network blip: try again on the next tick.
          }
        })();
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [polling]);

  async function take(picked: File[]) {
    for (const original of picked) {
      if (atCap(stateRef.current)) break;
      const key = nextKey.current++;
      const photo = await shrinkPhoto(original);
      if (atCap(stateRef.current)) break;
      const url = URL.createObjectURL(photo);
      files.current.set(key, photo);
      previews.current.set(key, url);
      // Keep the mirror current so the cap check sees this photo before the next render.
      stateRef.current = { entries: [...stateRef.current.entries, { key, name: photo.name, previewUrl: url, status: "waiting", scanId: null, uploadedAt: null, error: null, scan: null }] };
      dispatch({ type: "add", key, name: photo.name, previewUrl: url });
    }
  }

  const sum = summary(state);
  const full = state.entries.length >= MAX_QUEUE;
  const list = [...state.entries].reverse();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <label className={`${BUTTON_LABEL} bg-accent text-accent-text ${full ? "pointer-events-none opacity-50" : ""}`}>
          <span>Take photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={full}
            onChange={(e) => {
              const copy = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              void take(copy);
            }}
          />
        </label>
        <label className={`${BUTTON_LABEL} border border-border bg-surface-2 text-text ${full ? "pointer-events-none opacity-50" : ""}`}>
          <span>Choose photos</span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/heic"
            className="sr-only"
            disabled={full}
            onChange={(e) => {
              const copy = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              void take(copy);
            }}
          />
        </label>
      </div>

      {full ? <Notice tone="warn">Take a short break: open Review or Inventory, then come back.</Notice> : null}

      <p aria-live="polite" role="status" className="text-sm font-semibold">
        {state.entries.length > 0 ? summaryText(sum) : "Nothing scanned yet."}
      </p>

      {list.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {list.map((e) => (
            <li key={e.key}>
              <QueueRow
                entry={e}
                canRetry={files.current.has(e.key)}
                onRetry={() => dispatch({ type: "retry", key: e.key })}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {state.entries.length > 0 ? (
        <LinkButton href={sum.needsReview > 0 ? "/review" : "/items"} variant="secondary">Done scanning</LinkButton>
      ) : null}
    </div>
  );
}

function QueueRow({ entry, canRetry, onRetry }: { entry: QueueEntry; canRetry: boolean; onRetry: () => void }) {
  if (entry.status === "done" && entry.scan) {
    if (entry.scan.items.length === 0) {
      return <Notice tone="warn">No card found</Notice>;
    }
    return (
      <ul className="flex flex-col gap-2">
        {entry.scan.items.map((item) => <li key={item.id}><ItemRow item={item} /></li>)}
      </ul>
    );
  }
  return (
    <Card className="flex items-center gap-3 p-3">
      {entry.previewUrl ? (
        // Local preview of the photo just taken; not a server image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.previewUrl} alt="Photo being scanned" className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold">{STATUS_LABEL[entry.status]}</p>
        {entry.status === "failed" ? (
          <>
            <p role="alert" className="text-sm break-words text-danger">{entry.error}</p>
            {canRetry ? (
              <Button variant="secondary" onClick={onRetry} aria-label={`Retry sending ${entry.name}`}>Retry</Button>
            ) : (
              <p className="text-sm text-muted">Take the photo again to retry.</p>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}
