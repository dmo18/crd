"use client";

import { useEffect, useRef, useState } from "react";
import { PhotoPicker } from "@/components/capture/PhotoPicker";
import { ItemRow } from "@/components/items/ItemRow";
import { Button, Card, INPUT_CLASS, LinkButton, Notice } from "@/components/ui";
import type { ScanMode } from "@/db/schema";
import type { ScanView } from "@/lib/scans/view";

type Rules = Record<ScanMode, { min: number; max: number }>;

const MODES: { value: ScanMode; title: string; text: string }[] = [
  { value: "single", title: "One card", text: "Front photo, and a back photo if you have one. The back makes it more accurate." },
  { value: "multi", title: "Many cards in one photo", text: "Lay cards flat, not overlapping. Up to about 9 per photo works best." },
  { value: "sealed", title: "Sealed pack or box", text: "Never open it. Photograph the front, plus the seal or back if you can." },
  { value: "bulk", title: "Bulk lot", text: "Photograph the box or stack and its label. You get a count estimate and a list of cards worth pulling out." },
];

const WAITING: Record<ScanMode, string> = {
  single: "Reading your card...",
  multi: "Finding the cards in your photo...",
  sealed: "Looking at your sealed product...",
  bulk: "Looking over your bulk lot...",
};

const POLL_MS = 1500;
const GIVE_UP_MS = 3 * 60 * 1000;

type Phase =
  | { name: "form"; error?: string }
  | { name: "sending" }
  | { name: "waiting"; scanId: number }
  | { name: "result"; scan: ScanView };

export function ScanFlow({ rules }: { rules: Rules }) {
  const [mode, setMode] = useState<ScanMode>("single");
  const [front, setFront] = useState<File[]>([]);
  const [back, setBack] = useState<File[]>([]);
  const [source, setSource] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [waitedMode, setWaitedMode] = useState<ScanMode>("single");

  const single = mode === "single";
  const ready = single ? front.length >= rules.single.min : source.length >= rules[mode].min;
  const busy = phase.name === "sending" || phase.name === "waiting";

  function changeMode(next: ScanMode) {
    setMode(next);
    setFront([]);
    setBack([]);
    setSource([]);
    setPhase({ name: "form" });
  }

  async function submit() {
    setPhase({ name: "sending" });
    setWaitedMode(mode);
    const body = new FormData();
    body.set("mode", mode);
    if (hint.trim()) body.set("hint", hint.trim());
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

  const scanId = phase.name === "waiting" ? phase.scanId : null;
  const started = useRef(0);
  useEffect(() => {
    if (scanId === null) return;
    let stopped = false;
    started.current = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started.current > GIVE_UP_MS) {
        stopped = true;
        clearInterval(timer);
        setPhase({ name: "form", error: "This is taking longer than expected. Your scan may still finish: check View inventory in a minute." });
        return;
      }
      try {
        const res = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
        if (stopped || !res.ok) return;
        const scan = (await res.json()) as ScanView;
        if (stopped) return;
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
          {phase.name === "sending" ? "Sending your photos..." : WAITING[waitedMode]}
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
            <Notice tone="danger"><span role="alert">{scan.error ?? "The scan did not work. Please try again."}</span></Notice>
            <Button onClick={() => setPhase({ name: "form" })}>Try again</Button>
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
        if (ready) void submit();
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
              checked={mode === m.value}
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

      {single ? (
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

      {phase.name === "form" && phase.error ? <div role="alert"><Notice tone="danger">{phase.error}</Notice></div> : null}

      <Button type="submit" disabled={!ready || busy}>Scan</Button>
    </form>
  );
}
