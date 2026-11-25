"use client";

import { useActionState } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import { outcomeAction, type OutcomeState } from "@/lib/items/actions";

const START: OutcomeState = { error: null };

/** "Mark as sold" and "Mark as removed" on the item page. Each opens only when tapped. */
export function OutcomeForms({ id, today }: { id: number; today: string }) {
  const [sold, soldAction, soldBusy] = useActionState(outcomeAction, START);
  const [removed, removedAction, removedBusy] = useActionState(outcomeAction, START);
  return (
    <div className="flex flex-col gap-3">
      <details className="rounded-2xl border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">Mark as sold</summary>
        <form action={soldAction} className="flex flex-col gap-3 px-4 pb-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcome" value="sold" />
          <p className="text-sm text-muted">It leaves your totals and lists. You can put it back any time.</p>
          <Field label="Sold for ($, the whole row)" htmlFor={`sold-price-${id}`} hint="Optional.">
            <input id={`sold-price-${id}`} name="price" inputMode="decimal" maxLength={20} placeholder="12.50" className={INPUT_CLASS} />
          </Field>
          <Field label="Date sold" htmlFor={`sold-date-${id}`} hint="Optional.">
            <input id={`sold-date-${id}`} name="date" type="date" defaultValue={today} className={INPUT_CLASS} />
          </Field>
          {sold.error ? <Notice tone="danger"><span role="alert">{sold.error}</span></Notice> : null}
          <Button type="submit" disabled={soldBusy}>{soldBusy ? "Saving" : "Mark as sold"}</Button>
        </form>
      </details>
      <details className="rounded-2xl border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">Mark as removed</summary>
        <form action={removedAction} className="flex flex-col gap-3 px-4 pb-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcome" value="removed" />
          <p className="text-sm text-muted">For a card you gave away, lost or traded. It leaves your totals and lists. You can put it back any time.</p>
          {removed.error ? <Notice tone="danger"><span role="alert">{removed.error}</span></Notice> : null}
          <Button type="submit" variant="secondary" disabled={removedBusy}>{removedBusy ? "Saving" : "Mark as removed"}</Button>
        </form>
      </details>
    </div>
  );
}

/** "Back in my collection" for a sold or removed item. */
export function BackButton({ id }: { id: number }) {
  const [state, action, busy] = useActionState(outcomeAction, START);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="outcome" value="back" />
      {state.error ? <Notice tone="danger"><span role="alert">{state.error}</span></Notice> : null}
      <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving" : "Back in my collection"}</Button>
    </form>
  );
}
