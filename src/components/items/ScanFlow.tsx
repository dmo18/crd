"use client";

import { useEffect, useState } from "react";
import { PhotoPicker } from "@/components/capture/PhotoPicker";
import { ItemRow } from "@/components/items/ItemRow";
import { RapidScan } from "@/components/items/RapidScan";
import { Button, Card, INPUT_CLASS, LinkButton, Notice } from "@/components/ui";
import type { ScanMode } from "@/db/schema";
import type { ScanView } from "@/lib/scans/view";
import { scanTimedOut, waitingText } from "./scan-queue";

type Rules = Record<ScanMode, { min: number; max: number }>;
type Choice = ScanMode | "rapid";
export type LocationOption = { id: number; name: string };

const LOCATION_KEY = "crd.scan.location";

const MODES: { value: Choice; title: string; text: string }[] = [
  { value: "single", title: "One card", text: "Front photo, and a back photo if you have one. The back makes it more accurate." },
  { value: "multi", title: "Many cards in one photo", text: "Lay cards flat, not overlapping. Up to about 9 per photo works best." },
  { value: "sealed", title: "Sealed pack or box", text: "Never open it. Photograph the front, plus the seal or back if you can." },
  { value: "bulk", title: "Bulk lot", text: "Photograph the box or stack and its label. You get a count estimate and a list of cards worth pulling out." },
  { value: "rapid", title: "Rapid fire", text: "One card after another. Take a photo, it uploads, take the next. Results appear below as they finish." },
];

const WAITING: Record<ScanMode, string> = {
  single: "Reading your card...",
  multi: "Finding the cards in your photo...",
  sealed: "Looking at your sealed product...",
  bulk: "Looking over your bulk lot...",
};

const POLL_MS = 1500;

type Phase =
  | { name: "form"; error?: string }
  | { name: "sending" }
  | { name: "waiting"; scanId: number }
  | { name: "result"; scan: ScanView; retryError?: string };

export function ScanFlow({ rules, locations = [] }: { rules: Rules; locations?: LocationOption[] }) {
  const [choice, setChoice] = useState<Choice>("single");
  const mode: ScanMode = choice === "rapid" ? "single" : choice;
  const rapid = choice === "rapid";
  const [locationId, setLocationId] = useState("");
  const [front, setFront] = useState<File[]>([]);
  const [back, setBack] = useState<File[]>([]);
  const [source, setSource] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [waitedMode, setWaitedMode] = useState<ScanMode>("single");
  /** The latest progress from the server while waiting, for the place in line. */
  const [latest, setLatest] = useState<ScanView | null>(null);

  const single = mode === "single";
  const ready = single ? front.length >= rules.single.min : source.length >= rules[mode].min;
  const busy = phase.name === "sending" || phase.name === "waiting";

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
    setPhase({ name: "form" });
  }

  async function submit() {
    setPhase({ name: "sending" });
    setLatest(null);
    setWaitedMode(mode);
    const body = new FormData();
    body.set("mode", mode);
    if (hint.trim()) body.set("hint", hint.trim());
    if (locationId) body.set("locationId", locationId);
    if (single) {
      body.set("front", front[0]);
      if (back[0]) body.set("back", back[0]);
    } else {
      for (const f of source) body.append("source", f);
    }
    try {
      const res = await fetch("/api/scans", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { scanId?: number; error?: string };
      if (res.status === 201 && typeof data.scanId === "number") {
        setPhase({ name: "waiting", scanId: data.scanId });
      } else {
        setPhase({ name: "form", error: data.error ?? "Something went wrong. Please try again." });
      }
    } catch {
      setPhase({ name: "form", error: "Could not send the photos. Check your connection and try again." });
    }
  }

  /** Runs the same failed scan again on the server, with the photos it already has. */
  async function retryOnServer(scan: ScanView) {
    try {
      const res = await fetch(`/api/scans/${scan.id}/retry`, { method: "POST" });
      if (res.ok) {
        setLatest(null);
        setPhase({ name: "waiting", scanId: scan.id });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setPhase({ name: "result", scan, retryError: data.error ?? "Could not try again. Please try later." });
    } catch {
      setPhase({ name: "result", scan, retryError: "Could not reach the server. Check your connection and try again." });
    }
  }

  const scanId = phase.name === "waiting" ? phase.scanId : null;
  useEffect(() => {
    if (scanId === null) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
        if (stopped || !res.ok) return;
        const scan = (await res.json()) as ScanView;
        if (stopped) return;
        setLatest(scan);
        // The server reads one scan at a time, so waiting in line never times
        // out. Only a scan it has been reading for over 6 minutes is given up on.
        if (scanTimedOut(scan)) {
          stopped = true;
          clearInterval(timer);
          setPhase({ name: "form", error: "This is taking longer than expected. Your scan may still finish: check View inventory in a few minutes." });
          return;
        }
        if (scan.status === "done" || scan.status === "failed") {
          stopped = true;
          clearInterval(timer);
          setPhase({ name: "result", scan });
        }
      } catch {
        // A short network blip: try again on the next tick.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [scanId]);

  function reset() {
    setFront([]);
    setBack([]);
    setSource([]);
    setHint("");
    setPhase({ name: "form" });
  }

  if (phase.name === "waiting" || phase.name === "sending") {
    return (
      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <div aria-hidden="true" className="size-10 animate-spin rounded-full border-4 border-border border-t-accent" />
        <p aria-live="polite" role="status" className="text-lg font-semibold">
          {phase.name === "sending" ? "Sending your photos..." : (waitingText(latest) ?? WAITING[waitedMode])}
        </p>
        <p className="text-sm text-muted">This usually takes under a minute. You can leave this screen on.</p>
      </Card>
    );
  }

  if (phase.name === "result") {
    const { scan } = phase;
    return (
      <div className="flex flex-col gap-4">
        {scan.status === "failed" ? (
          <>
            <Notice tone="danger"><span role="alert">{phase.retryError ?? scan.error ?? "The scan did not work. Please try again."}</span></Notice>
            <Button onClick={() => void retryOnServer(scan)}>Try again</Button>
            <Button variant="secondary" onClick={() => setPhase({ name: "form" })}>Change the photos</Button>
          </>
        ) : scan.items.length === 0 ? (
          <>
            <Notice tone="warn">No card found in that photo. Try a closer, sharper photo with less glare.</Notice>
            <Button onClick={() => setPhase({ name: "form" })}>Try again</Button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">
              {scan.items.length === 1 ? "Found 1 item" : `Found ${scan.items.length} items`}
            </h2>
            <ul className="flex flex-col gap-3">
              {scan.items.map((item) => <li key={item.id}><ItemRow item={item} /></li>)}
            </ul>
          </>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button onClick={reset} className="sm:flex-1">Scan another</Button>
          <LinkButton href="/items" variant="secondary" className="sm:flex-1">View inventory</LinkButton>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !rapid) void submit();
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

      {rapid ? <RapidScan hint={hint} locationId={locationId} /> : null}

      {!rapid && phase.name === "form" && phase.error ? <div role="alert"><Notice tone="danger">{phase.error}</Notice></div> : null}

      {rapid ? null : <Button type="submit" disabled={!ready || busy}>Scan</Button>}
    </form>
  );
}
