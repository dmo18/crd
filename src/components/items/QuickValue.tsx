"use client";

import { useActionState } from "react";
import { Button, Field, INPUT_CLASS } from "@/components/ui";
import { quickValueAction, type QuickValueState } from "@/lib/items/quick-value-actions";

const START: QuickValueState = { saved: false, error: null };

/** One box to type the sold price you saw, and a button to save it as this item's value. */
export function QuickValue({ itemId, help, label = "Price you saw" }: { itemId: number; help?: string; label?: string }) {
  const [state, action, pending] = useActionState(quickValueAction, START);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={itemId} />
      {help ? <p className="text-sm">{help}</p> : null}
      <Field label={label} htmlFor={`qv-${itemId}`}>
        <input id={`qv-${itemId}`} name="price" type="text" inputMode="decimal" placeholder="12.50"
          autoComplete="off" maxLength={14} required className={INPUT_CLASS} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save price"}</Button>
      <p aria-live="polite" className={state.error ? "text-sm text-danger" : "text-sm text-accent"}>
        {state.error ?? (state.saved ? "Saved." : "")}
      </p>
    </form>
  );
}
