"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PhotoPicker } from "@/components/capture/PhotoPicker";
import { shrinkPhoto } from "@/components/capture/shrink";
import { Badge, Button, Card, INPUT_CLASS, LinkButton, Notice } from "@/components/ui";
import type { ScanMode } from "@/db/schema";
import {
  entryState, hasUnsaved, KEEP_OPEN_MESSAGE, SIGNED_OUT_MESSAGE, listFull, liveText, retryKind, summary, summaryText, waitingText, type QueueEntry,
} from "./scan-queue";
import { useScanQueue } from "./ScanQueueProvider";

type Rules = Record<ScanMode, { min: number; max: number }>;
type Choice = ScanMode | "rapid";
export type LocationOption = { id: number; name: string };

const LOCATION_KEY = "crd.scan.location";
const BUTTON_LABEL = "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-base font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

const MODES: { value: Choice; title: string; text: string }[] = [
  { value: "single", title: "One card", text: "Front photo, and a back photo if you have one. The back makes it more accurate." },
  { value: "multi", title: "Many cards in one photo", text: "Lay cards flat, not overlapping. Up to about 9 per photo works best. The first photo shows the fronts. You can add a second photo of their backs, laid out any way." },
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
  // The list and the uploads live in the (app) layout, so they keep going on other pages.
  const { state, store } = useScanQueue();

  // Latest form values for photos still being shrunk after the tap.
  const hintRef = useRef(hint);
  const locationRef = useRef(locationId);
  useEffect(() => {
    hintRef.current = hint;
    locationRef.current = locationId;
  });

  const unsaved = hasUnsaved(state);

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

  const single = mode === "single";
  const ready = single ? front.length >= rules.single.min : source.length >= rules[mode].min;
  const full = listFull(state);

  function save() {
    if (!ready || full) return;
    const files = single ? [front[0], back[0]].filter(Boolean) : source;
    // Puts one scan in the list, to be sent. The form is free again at once.
    const ok = store.enqueue(
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
      if (listFull(store.getState())) break;
      const photo = await shrinkPhoto(original);
      // Add straight away: the cap check sees this photo before the next one is looked at.
      store.enqueue({ mode: "single", hint: hintRef.current, locationId: locationRef.current, front: photo, source: [] }, photo, photo.name);
    }
  }

  // Newest first; each keeps its own number for this visit.
  const list = state.entries.map((entry) => ({ entry, n: entry.key })).reverse();

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

      {full ? <Notice tone="warn">The list is full. Wait for some photos to finish saving and being read, then add more.</Notice> : null}

      {/* Always on the page, so screen readers hear every change in the counts and the keep open notice. */}
      <p role="status" aria-live="polite" className="sr-only">{liveText(state)}</p>

      {unsaved ? <Notice tone="warn">{KEEP_OPEN_MESSAGE}</Notice> : null}

      {list.length > 0 ? (
        <section aria-labelledby="scan-entries" className="flex flex-col gap-3">
          <h2 id="scan-entries" className="text-lg font-semibold">This visit</h2>
          <p className="text-sm font-semibold">{summaryText(summary(state))}</p>
          <ul className="flex flex-col gap-3">
            {list.map(({ entry, n }) => (
              <li key={entry.key}>
                <EntryRow entry={entry} n={n} onRetry={() => void store.retry(entry.key)} onCheck={() => void store.poll()} />
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

function SignInLink({ n }: { n: number }) {
  // A new tab, so this page keeps the photos while the owner signs in.
  return (
    <a
      href="/login"
      target="_blank"
      rel="noopener"
      aria-label={`Sign in again for scan ${n}, opens a new tab`}
      className="inline-flex min-h-11 items-center text-accent underline"
    >
      Sign in again
    </a>
  );
}

function EntryRow({ entry, n, onRetry, onCheck }: { entry: QueueEntry; n: number; onRetry: () => void; onCheck: () => void }) {
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
        <img src={entry.previewUrl} alt={`Photo for scan ${n}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-xs text-muted break-words">Scan {n}: {entry.name}</p>
        <p className={`font-semibold ${tone}`}>{kind === "read" || kind === "check" ? (kind === "check" ? text : "Read") : text}</p>
        {wait ? <p className="text-sm text-muted">{wait}</p> : null}
        {entry.status === "reading" && entry.signedOut ? (
          <>
            <p className="text-sm break-words text-danger">{SIGNED_OUT_MESSAGE}</p>
            <SignInLink n={n} />
            <Button variant="secondary" onClick={onCheck} aria-label={`Check scan ${n} again`}>Check again</Button>
          </>
        ) : null}
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
            <Link href="/review" aria-label={`Check scan ${n} in Review`} className="inline-flex min-h-11 items-center text-accent underline">Check in Review</Link>
          </div>
        ) : null}
        {kind === "slow" ? (
          <p className="text-sm text-muted">It may still finish. Look under See what was read in a few minutes.</p>
        ) : null}
        {entry.status === "failed" ? (
          <>
            {kind !== "slow" ? <p className="text-sm break-words text-danger">{entry.error}</p> : null}
            {entry.failure === "signIn" && entry.scanId === null ? <SignInLink n={n} /> : null}
            {entry.failure === "signIn" && kindOfRetry ? <p className="text-sm text-muted">Sign in, then come back and tap Retry.</p> : null}
            {kindOfRetry ? (
              <Button variant="secondary" onClick={onRetry} aria-label={`Retry scan ${n}`}>Retry</Button>
            ) : entry.scanId === null ? (
              <p className="text-sm text-muted">
                {entry.failure === "final" ? "Trying again will not help. Take the photos again." : "The photo is no longer on this page. Take it again."}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
