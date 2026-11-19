"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { refreshGuideAction, type GuideRefreshState } from "@/lib/valuation/guide/actions";

const START: GuideRefreshState = { message: null, error: null };

/** Works out the built-in guide price again from the card's details. */
export function GuideRefresh({ itemId }: { itemId: number }) {
  const [state, action, pending] = useActionState(refreshGuideAction, START);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={itemId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Working it out..." : "Refresh guide price"}
      </Button>
      <p aria-live="polite" className={state.error ? "text-sm text-danger" : "text-sm text-accent"}>
        {state.error ?? state.message ?? ""}
      </p>
    </form>
  );
}
