"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { revalueItemAction, type RevalueState } from "@/lib/items/value-actions";

const START: RevalueState = { message: null, error: null };

/** Button that asks for a fresh value estimate for one item. */
export function ValueTools({ itemId }: { itemId: number }) {
  const [state, action, pending] = useActionState(revalueItemAction, START);
  return (
    <form action={action} className="flex flex-col gap-2 pt-3">
      <input type="hidden" name="id" value={itemId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Estimating..." : "Get a fresh estimate"}
      </Button>
      <p className="text-xs text-muted">Use this after you change the condition or details.</p>
      <p aria-live="polite" className={state.error ? "text-sm text-danger" : "text-sm text-accent"}>
        {state.error ?? state.message ?? ""}
      </p>
    </form>
  );
}
