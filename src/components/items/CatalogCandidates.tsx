"use client";

import { useActionState } from "react";
import { Badge, Button } from "@/components/ui";
import { ChooseVersionLink } from "@/components/catalog/VersionPicker";
import type { ReviewCatalogView } from "@/lib/catalog/pick";
import {
  dismissCandidatesAction, lookUpAgainAction, pickCandidateAction, catalogValuesAction, type CatalogActionState,
} from "@/lib/items/review-actions";

const NONE: CatalogActionState = { message: null };
/** Rows shown at once; the rest sit behind "More". */
const SHOWN = 3;

type Row = ReviewCatalogView["candidates"][number];

function SourceLink({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
      From MyCardfolio (opens in a new tab)
    </a>
  );
}

function CandidateRow({ id, row, action, pending }: { id: number; row: Row; action: (f: FormData) => void; pending: boolean }) {
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-border bg-surface-2 p-3">
      <p className="font-semibold break-words">{row.line}</p>
      {row.verified ? null : <div><Badge tone="warn">Unverified listing</Badge></div>}
      {row.differs ? <p className="text-sm break-words">{row.differs}</p> : null}
      <SourceLink url={row.url} />
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="position" value={row.position} />
        <input type="hidden" name="sourceId" value={row.sourceId} />
        <Button type="submit" className="w-full" disabled={pending} aria-label={`This is my card: ${row.line}`}>
          This is my card
        </Button>
      </form>
    </li>
  );
}

/**
 * The catalog part of one Review row: the short list to pick from with one
 * tap, the details that differ after a pick, or a plain line when the
 * catalog was not checked. Everything is decided on the server; the browser
 * sends back only the item id and a place in the stored list.
 */
export function CatalogCandidates({ id, title, view, notCheckedLine }: {
  id: number; title: string; view: ReviewCatalogView; notCheckedLine: string | null;
}) {
  const [picked, pick, picking] = useActionState(pickCandidateAction, NONE);
  const [looked, lookUp, looking] = useActionState(lookUpAgainAction, NONE);
  const message = looked.message ?? picked.message;
  const lookUpButton = view.canLookUp ? (
    <form action={lookUp} className="flex-1">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" className="w-full" disabled={looking} aria-label={`Look up ${title} again in the catalog`}>
        {looking ? "Looking up..." : "Look up again"}
      </Button>
    </form>
  ) : null;

  return (
    <section className="flex flex-col gap-2" aria-label={`Catalog for ${title}`}>
      {view.linked ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm"><span className="text-muted">Catalog card: </span><span className="font-semibold break-words">{view.linked.line}</span></p>
          <SourceLink url={view.linked.url} />
          {view.linked.differences.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-3">
              <p className="text-sm font-semibold">Some details differ from the catalog:</p>
              <ul className="flex flex-col gap-1 text-sm">
                {view.linked.differences.map((d) => (
                  <li key={d.label} className="break-words">Scanner read {d.label}: {d.read}. Catalog says: {d.catalog}</li>
                ))}
              </ul>
              <form action={catalogValuesAction}>
                <input type="hidden" name="id" value={id} />
                <Button type="submit" className="w-full" aria-label={`Use the catalog's values for ${title}`}>Use the catalog&apos;s values</Button>
              </form>
              <p className="text-xs text-muted">Or tap Confirm to keep what the scanner read. Details you typed yourself are never changed.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {view.status === "candidates" && view.candidates.length > 0 ? (
        <>
          {view.severalVersions ? <ChooseVersionLink itemId={id} title={title} /> : null}
          <p className="text-sm font-semibold">Is it one of these?</p>
          <ul className="flex flex-col gap-2">
            {view.candidates.slice(0, SHOWN).map((row) => <CandidateRow key={row.position} id={id} row={row} action={pick} pending={picking || looking} />)}
          </ul>
          {view.candidates.length > SHOWN ? (
            <details>
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">More ({view.candidates.length - SHOWN})</summary>
              <ul className="flex flex-col gap-2">
                {view.candidates.slice(SHOWN).map((row) => <CandidateRow key={row.position} id={id} row={row} action={pick} pending={picking || looking} />)}
              </ul>
            </details>
          ) : null}
          <p className="text-xs text-muted">Picking one fills in only empty details. What the scanner read stays until you choose.</p>
          <div className="flex gap-2">
            <form action={dismissCandidatesAction} className="flex-1">
              <input type="hidden" name="id" value={id} />
              <Button type="submit" variant="secondary" className="w-full" aria-label={`None of these is ${title}`}>None of these</Button>
            </form>
            {lookUpButton}
          </div>
        </>
      ) : null}

      {view.status === "none" ? (
        <>
          <p className="text-sm text-muted">Not found in the catalog. Check the year, brand and player, then look it up again.</p>
          {lookUpButton ? <div className="flex">{lookUpButton}</div> : null}
        </>
      ) : null}

      {view.status === "not_checked" ? (
        <>
          <p className="text-sm"><span className="font-semibold">Catalog not checked.</span> {notCheckedLine} The scanner&apos;s reading is kept.</p>
          {lookUpButton ? <div className="flex">{lookUpButton}</div> : null}
        </>
      ) : null}

      {view.status === null && !view.linked && lookUpButton ? <div className="flex">{lookUpButton}</div> : null}

      {message ? <p role="status" className="text-sm font-semibold">{message}</p> : null}
    </section>
  );
}
