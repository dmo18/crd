"use client";

import { useActionState } from "react";
import { Button, Notice } from "@/components/ui";
import { ROOKIE_STATES } from "@/db/schema";
import { ROOKIE_STATE_LABELS } from "@/lib/items/rookie";
import { rookieAnswerAction, type AskState } from "@/lib/items/suggest-actions";
import type { RookieState } from "@/db/schema";

const NONE: AskState = { message: null };

export type RookieAskView = { lines: string[]; suggested: RookieState | null; current: RookieState | null };

/** "Rookie card?" with the evidence in plain words and four answers. The answer is the owner's and is never changed by the app. */
export function RookieAsk({ itemId, title, view }: { itemId: number; title: string; view: RookieAskView }) {
  const [state, action, pending] = useActionState(rookieAnswerAction, NONE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3" aria-label={`Rookie card? ${title}`}>
      <input type="hidden" name="id" value={itemId} />
      <p className="text-base font-semibold">Rookie card?</p>
      {view.current ? <p className="text-sm">Now marked: {ROOKIE_STATE_LABELS[view.current]}.</p> : null}
      {view.lines.map((l) => <p key={l} className="text-sm text-muted break-words">{l.replace(/\.$/, "")}.</p>)}
      <div className="grid grid-cols-2 gap-2">
        {ROOKIE_STATES.map((v) => (
          <Button key={v} type="submit" name="answer" value={v} variant={view.suggested === v ? "primary" : "secondary"} disabled={pending} aria-label={`${ROOKIE_STATE_LABELS[v]}, ${title}`}>
            {ROOKIE_STATE_LABELS[v]}
          </Button>
        ))}
      </div>
      {state.message ? <div role="alert"><Notice tone="danger">{state.message}</Notice></div> : null}
    </form>
  );
}
