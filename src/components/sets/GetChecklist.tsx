"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { getChecklistAction, type ChecklistState } from "@/lib/sets/actions";

const START: ChecklistState = { result: null, error: null };

/** "Get the checklist" (or "Get it again"): one tap, one set, through the shared catalog limits. */
export function GetChecklist({ setKey, again }: { setKey: string; again: boolean }) {
  const [state, action, busy] = useActionState(getChecklistAction, START);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="key" value={setKey} />
      <Button type="submit" variant={again ? "secondary" : "primary"} disabled={busy} className="w-full">
        {busy ? "Getting the checklist..." : again ? "Get it again" : "Get the checklist"}
      </Button>
      <p aria-live="polite" className="text-sm text-muted">
        {busy ? "This asks the free card catalog. It can take up to half a minute." : state.error ?? ""}
      </p>
    </form>
  );
}
