"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Badge, Button, Card, Field, INPUT_CLASS, Notice } from "@/components/ui";
import { SPORTS } from "@/db/schema";
import { SPORT_LABELS } from "@/lib/items/labels";
import {
  addCatalogCardAction, searchCardsAction, type AddState, type SearchRow, type SearchState,
} from "@/lib/catalog/actions";
import { SEARCH_MAX } from "@/lib/catalog/messages";

const INITIAL: SearchState = { status: "idle", message: null, rows: [], asked: null };
const NO_ADD: AddState = { message: null };

function ResultRow({ row, itemId }: { row: SearchRow; itemId: number | null }) {
  const [state, action, pending] = useActionState(addCatalogCardAction, NO_ADD);
  const label = itemId === null ? "Add to my collection" : "This is my card";
  return (
    <li>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-semibold break-words">{row.line}</p>
          {row.verified ? null : <div><Badge tone="warn">Unverified listing</Badge></div>}
        </div>
        {row.verified ? null : (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">Read the details first</summary>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              {row.shown.map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words">{v}</dd></div>
              ))}
            </dl>
            <p className="pt-2 text-muted">This entry has not been checked. It may be wrong or mixed up with another card.</p>
          </details>
        )}
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="sourceId" value={row.sourceId} />
          {itemId === null ? null : <input type="hidden" name="itemId" value={itemId} />}
          {row.verified ? null : (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="readDetails" className="size-5 accent-accent" />
              <span>I read the details and this is my card</span>
            </label>
          )}
          <Button type="submit" disabled={pending} className="w-full" aria-label={`${label}: ${row.line}`}>
            {pending ? "Saving..." : label}
          </Button>
          {state.message ? <div role="alert"><Notice tone="danger">{state.message}</Notice></div> : null}
        </form>
        <a href={row.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
          From MyCardfolio (opens in a new tab)
        </a>
      </Card>
    </li>
  );
}

export function SearchScreen({ initialText, initialSport, initialYear, itemId, itemTitle }: {
  initialText: string; initialSport: string; initialYear: string; itemId: number | null; itemTitle: string | null;
}) {
  const [state, action, pending] = useActionState(searchCardsAction, INITIAL);
  const [sport, setSport] = useState(initialSport);
  const clean = state.rows.filter((r) => r.verified);
  const loose = state.rows.filter((r) => !r.verified);
  return (
    <div className="flex flex-col gap-4">
      {itemId !== null ? (
        <Notice tone="accent">Finding the catalog card for {itemTitle}. Your own words on the item are kept.</Notice>
      ) : null}
      <form action={action} className="flex flex-col gap-3">
        <Field label="Words to search" htmlFor="s-q" hint="Year, brand, player. For example: 1990 Topps Griffey.">
          <input id="s-q" name="q" type="search" defaultValue={initialText} minLength={2} maxLength={SEARCH_MAX} required className={INPUT_CLASS} />
        </Field>
        <Field label="Sport (optional)" htmlFor="s-sport">
          <select id="s-sport" name="sport" value={sport} onChange={(e) => setSport(e.target.value)} className={INPUT_CLASS}>
            <option value="">Any sport</option>
            {SPORTS.map((s) => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
          </select>
        </Field>
        {sport === "basketball" || sport === "hockey" ? (
          <Notice tone="warn">The catalog has few checked entries for this sport. Most results will be unverified listings.</Notice>
        ) : null}
        <Field label="Year (optional)" htmlFor="s-year">
          <input id="s-year" name="year" type="text" inputMode="numeric" maxLength={4} defaultValue={initialYear} className={INPUT_CLASS} />
        </Field>
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Searching..." : "Search"}</Button>
      </form>

      <div aria-live="polite" className="flex flex-col gap-4">
        {state.status === "error" ? (
          <>
            <Notice tone="warn">{state.message}</Notice>
            <Link href="/items/new" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Add a card by hand</Link>
          </>
        ) : null}
        {state.status === "done" && state.rows.length === 0 ? (
          <Notice>Nothing found for &quot;{state.asked}&quot;. Try fewer words, like just the player and year, or add the card by hand.</Notice>
        ) : null}
        {clean.length > 0 ? <ul className="flex flex-col gap-3">{clean.map((r) => <ResultRow key={r.sourceId} row={r} itemId={itemId} />)}</ul> : null}
        {state.status === "done" && clean.length === 0 && loose.length > 0 ? (
          <Notice tone="warn">Only unverified listings were found. Read each one before you use it.</Notice>
        ) : null}
        {loose.length > 0 ? (
          <details className="flex flex-col gap-3">
            <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold">Unverified listings ({loose.length})</summary>
            <ul className="flex flex-col gap-3 pt-2">{loose.map((r) => <ResultRow key={r.sourceId} row={r} itemId={itemId} />)}</ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
