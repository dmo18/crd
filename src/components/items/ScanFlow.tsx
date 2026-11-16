"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PhotoPicker } from "@/components/capture/PhotoPicker";
import { shrinkPhoto } from "@/components/capture/shrink";
import { Badge, Button, Card, INPUT_CLASS, LinkButton, Notice } from "@/components/ui";
import type { ScanMode } from "@/db/schema";
import type { ScanView } from "@/lib/scans/view";
import {
  atCap, createUploader, emptyQueue, entryState, hasUnsaved, MAX_QUEUE, postScan, queueReducer, retryKind, scanTimedOut, summary,
  summaryText, waitingText, type QueueAction, type QueueEntry, type QueueState, type ScanJob,
} from "./scan-queue";

type Rules = Record<ScanMode, { min: number; max: number }>;
type Choice = ScanMode | "rapid";
export type LocationOption = { id: number; name: string };

const LOCATION_KEY = "crd.scan.location";
const POLL_MS = 2000;
const SAVED_EVENT = "crd:scan-saved";
const BUTTON_LABEL = "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-base font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

const MODES: { value: Choice; title: string; text: string }[] = [
  { value: "single", title: "One card", text: "Front photo, and a back photo if you have one. The back makes it more accurate." },
  { value: "multi", title: "Many cards in one photo", text: "Lay cards flat, not overlapping. Up to about 9 per photo works best." },
  { value: "sealed", title: "Sealed pack or box", text: "Never open it. Photograph the front, plus the seal or back if you can." },
  { value: "bulk", title: "Bulk lot", text: "Photograph the box or stack and its label. You get a count estimate and a list of cards worth pulling out." },
  { value: "rapid", title: "One card, fronts only, many in a row", text: "Take a photo and it is saved at once. Take the next one right away." },
];

const MODE_NAME: Record<ScanMode, string> = { single: "One card", multi: "Many cards", sealed: "Sealed product", bulk: "Bulk lot" };

export function ScanFlow({ rules, locations = [] }: { rules: Rules; locations?: LocationOption[] }) {
  const [choice, setChoice] = useState<Choice>("single");
  const mode: ScanMode = choice === "rapid" ? "single" : choice;
  const rapid = choice === "rapid";
  const [locationId, setLocationId] = useState("");
  const [front, setFront] = useState<File[]>([]);
  const [back, setBack] = useState<File[]>([]);
  const [source, setSource] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [state, setState] = useState<QueueState>(emptyQueue);

  // Latest values for code that runs later (timers, uploads, polling).
  const stateRef = useRef<QueueState>(emptyQueue);
  const jobs = useRef(new Map<number, ScanJob>());
  const previews = useRef(new Map<number, string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextKey = useRef(1);
  const hintRef = useRef(hint);
  const locationRef = useRef(locationId);
  useEffect(() => {
    hintRef.current = hint;
    locationRef.current = locationId;
  });

  function release(key: number) {
    const url = previews.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(key);
    jobs.current.delete(key);
  }

  function dispatch(action: QueueAction) {
    stateRef.current = queueReducer(stateRef.current, action);
    setState(stateRef.current);
  }

  const uploaderRef = useRef<ReturnType<typeof createUploader> | null>(null);

  // Start waiting entries whenever something changes.
  useEffect(() => {
    uploaderRef.current ??= createUploader({
      getState: () => stateRef.current,
      dispatch,
      send: async (key) => {
        const job = jobs.current.get(key);
        if (!job) return { ok: false, message: "This photo is no longer on the page. Take it again." };
        return postScan(fetch, job);
      },
      later: (fn, ms) => {
        const id = setTimeout(() => {
          timers.current.delete(id);
          fn();
        }, ms);
        timers.current.add(id);
      },
      now: () => Date.now(),
      onSaved: (key) => {
        // The server has the photos: the page can let go of the files.
        const job = jobs.current.get(key);
        if (job) jobs.current.set(key, { ...job, front: undefined, back: undefined, source: [] });
        window.dispatchEvent(new Event(SAVED_EVENT));
      },
    });
    uploaderRef.current.pump();
  }, [state]);

  // Leave warning while anything is not yet on the server.
  const unsaved = hasUnsaved(state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // One timer checks every saved entry that is still being read.
  const polling = state.entries.some((e) => e.status === "reading");
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const timer = setInterval(() => {
      for (const e of stateRef.current.entries) {
        if (e.status !== "reading" || e.scanId === null) continue;
        // Only a scan the server has been reading for over 6 minutes is given up on;
        // one waiting in line keeps being checked.
        if (scanTimedOut(e.scan)) {
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

  // Let go of timers and photo previews when the screen closes.
  useEffect(() => {
    const held = previews.current;
    const pending = timers.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
      for (const id of pending) clearTimeout(id);
      pending.clear();
    };
  }, []);

  // Restore the remembered location after the first render (localStorage is browser only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved && locations.some((l) => String(l.id) === saved)) setLocationId(saved);
    } catch {
      // Storage can be blocked; the choice just is not remembered.
    }
  }, [locations]);

  function changeLocation(value: string) {
    setLocationId(value);
    try {
      localStorage.setItem(LOCATION_KEY, value);
    } catch {
      // Ignore: remembering is a convenience only.
    }
  }

  function changeMode(next: Choice) {
    setChoice(next);
    setFront([]);
    setBack([]);
    setSource([]);
  }

  /** Puts one scan in the list, to be sent. The form is free again at once. */
  function enqueue(job: Omit<ScanJob, "clientKey">, preview: File, name: string) {
    if (atCap(stateRef.current)) return false;
    const key = nextKey.current++;
    const clientKey = crypto.randomUUID();
    const url = URL.createObjectURL(preview);
    jobs.current.set(key, { ...job, clientKey });
    previews.current.set(key, url);
    dispatch({ type: "add", key, clientKey, name, previewUrl: url });
    return true;
  }

  const single = mode === "single";
  const ready = single ? front.length >= rules.single.min : source.length >= rules[mode].min;
  const full = state.entries.length >= MAX_QUEUE;

  function save() {
    if (!ready || full) return;
    const files = single ? [front[0], back[0]].filter(Boolean) : source;
    const ok = enqueue(
      { mode, hint, locationId, front: single ? front[0] : undefined, back: single ? back[0] : undefined, source: single ? [] : source },
      files[0],
      MODE_NAME[mode],
    );
    if (!ok) return;
    setFront([]);
    setBack([]);
    setSource([]);
    setHint("");
  }

  async function take(picked: File[]) {
    for (const original of picked) {
      if (atCap(stateRef.current)) break;
      const photo = await shrinkPhoto(original);
      // Add straight away: the cap check sees this photo before the next one is looked at.
      enqueue({ mode: "single", hint: hintRef.current, locationId: locationRef.current, front: photo, source: [] }, photo, photo.name);
    }
  }

  /** Retry: send the photo again if the server never got it; otherwise run the same scan again on the server. */
  async function retry(entry: QueueEntry) {
    const kind = retryKind(entry);
    if (kind === "upload") {
      dispatch({ type: "retry", key: entry.key });
      return;
    }
    if (kind !== "server" || entry.scanId === null) return;
    try {
      const res = await fetch(`/api/scans/${entry.scanId}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as (ScanView & { error?: string }) | null;
      if (res.ok) dispatch({ type: "requeued", key: entry.key, scan: data });
      else dispatch({ type: "retryError", key: entry.key, message: data?.error ?? "Could not try again. Please try later." });
    } catch {
      dispatch({ type: "retryError", key: entry.key, message: "Could not reach the server. Check your connection and try again." });
    }
  }

  const list = [...state.entries].reverse();

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!rapid) save();
        }}
      >
        <fieldset className="flex flex-col gap-3">
          <legend className="pb-2 text-base font-semibold">What are you scanning?</legend>
          {MODES.map((m) => (
            <label
              key={m.value}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-border bg-surface p-4 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
            >
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={choice === m.value}
                onChange={() => changeMode(m.value)}
                className="mt-1 size-5 shrink-0 accent-accent"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold">{m.title}</span>
                <span className="text-sm text-muted">{m.text}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {locations.length > 0 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="scan-location" className="text-sm font-semibold">Store in</label>
            <select
              id="scan-location"
              value={locationId}
              onChange={(e) => changeLocation(e.target.value)}
              className={INPUT_CLASS}
              aria-describedby="scan-location-help"
            >
              <option value="">No location</option>
              {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
            </select>
            <p id="scan-location-help" className="text-xs text-muted">Add boxes and binders under More, then Locations.</p>
          </div>
        ) : null}

        {rapid ? null : single ? (
          <div className="flex flex-col gap-5">
            <PhotoPicker label="Front" max={1} value={front} onChange={setFront} captureFirst />
            <PhotoPicker label="Back (optional)" max={1} value={back} onChange={setBack} />
          </div>
        ) : (
          <PhotoPicker
            key={mode}
            label={mode === "multi" ? "Photos of your cards" : mode === "sealed" ? "Photos of the sealed product" : "Photos of the lot"}
            max={rules[mode].max}
            value={source}
            onChange={setSource}
            captureFirst
          />
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="scan-hint" className="text-sm font-semibold">Hint</label>
          <input
            id="scan-hint"
            type="text"
            maxLength={200}
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            className={INPUT_CLASS}
            aria-describedby="scan-hint-help"
          />
          <p id="scan-hint-help" className="text-xs text-muted">Optional. For example: 1989 Topps baseball</p>
        </div>

        {rapid ? (
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
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
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
        ) : (
          <Button type="submit" disabled={!ready || full}>Save</Button>
        )}
      </form>

      {full ? <Notice tone="warn">That is the most for one visit. Open Review or Inventory, then come back.</Notice> : null}

      {unsaved ? <Notice tone="warn">Keep this page open until your photos are saved.</Notice> : null}

      {list.length > 0 ? (
        <section aria-labelledby="scan-entries" className="flex flex-col gap-3">
          <h2 id="scan-entries" className="text-lg font-semibold">This visit</h2>
          <p aria-live="polite" role="status" className="text-sm font-semibold">{summaryText(summary(state))}</p>
          <ul className="flex flex-col gap-3">
            {list.map((e) => (
              <li key={e.key}>
                <EntryRow entry={e} onRetry={() => void retry(e)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {list.length > 0 ? (
        <LinkButton href="/scans" variant="secondary">See what was read</LinkButton>
      ) : null}
    </div>
  );
}

function EntryRow({ entry, onRetry }: { entry: QueueEntry; onRetry: () => void }) {
  const { kind, text } = entryState(entry);
  const kindOfRetry = retryKind(entry);
  const items = entry.scan?.items ?? [];
  const thumb = entry.status === "done" ? (items[0]?.thumb ?? null) : null;
  const wait = entry.status === "reading" ? waitingText(entry.scan) : null;
  const tone = kind === "not_saved" || kind === "did_not_work" ? "text-danger" : "text-text";

  return (
    <Card className="flex items-start gap-3 p-3">
      {entry.status === "done" ? (
        thumb ? (
          // Photos come from our own /api/images route, already resized.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/images/${thumb}`} alt="" className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
        ) : (
          <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
        )
      ) : entry.previewUrl ? (
        // Local preview of the photo just taken; not a server image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.previewUrl} alt={`Photo: ${entry.name}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className={`font-semibold ${tone}`}>{kind === "read" || kind === "check" ? (kind === "check" ? text : "Read") : text}</p>
        {wait ? <p className="text-sm text-muted">{wait}</p> : null}
        {kind === "saving" && entry.status === "backoff" && entry.error ? <p className="text-sm text-muted">{entry.error}</p> : null}
        {kind === "read" || kind === "check" ? (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.id}>
                <Link href={`/items/${item.id}`} className="inline-flex min-h-11 items-center text-accent underline break-words">
                  {kind === "read" ? `Read: ${item.title}` : item.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {kind === "check" ? (
          <div className="flex flex-wrap gap-2">
            <Badge tone="warn">Needs a look</Badge>
            <Link href="/review" className="inline-flex min-h-11 items-center text-accent underline">Check in Review</Link>
          </div>
        ) : null}
        {kind === "slow" ? (
          <p className="text-sm text-muted">It may still finish. Look under See what was read in a few minutes.</p>
        ) : null}
        {entry.status === "failed" ? (
          <>
            {kind !== "slow" ? <p role="alert" className="text-sm break-words text-danger">{entry.error}</p> : null}
            {kindOfRetry ? (
              <Button variant="secondary" onClick={onRetry} aria-label={`Retry: ${entry.name}`}>Retry</Button>
            ) : entry.scanId === null ? (
              <p className="text-sm text-muted">The photo is no longer on this page. Take it again.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
