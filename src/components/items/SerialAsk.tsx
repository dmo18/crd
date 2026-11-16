"use client";

import { useActionState, useState } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import { serialAnswerAction, type AskState } from "@/lib/items/suggest-actions";

const NONE: AskState = { message: null };

export type SerialAskView = { copy: string | null; edition: string; line: string; weak: boolean; why: string[] };

/**
 * "Is this the serial number?" The scanner only read it; nothing is saved
 * until a tap. A weak read has no Yes button, only Fix it and No.
 */
export function SerialAsk({ itemId, title, view }: { itemId: number; title: string; view: SerialAskView }) {
  const [state, action, pending] = useActionState(serialAnswerAction, NONE);
  const [fixing, setFixing] = useState(false);
  const read = `${view.copy ?? ""}/${view.edition}`;
  const hid = `serial-ask-${itemId}`;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3" aria-labelledby={`${hid}-q`}>
      <input type="hidden" name="id" value={itemId} />
      <p id={`${hid}-q`} className="text-base font-semibold break-words">The scanner read {read}. Is this the serial number?</p>
      {view.weak ? (
        <>
          <p className="text-sm break-words">It came from this line of text: &quot;{view.line}&quot;</p>
          {view.why.map((w) => <p key={w} className="text-sm text-muted break-words">{w}.</p>)}
        </>
      ) : null}
      {fixing ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Copy" htmlFor={`${hid}-copy`}>
            <input id={`${hid}-copy`} name="serialCopy" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} defaultValue={view.copy ?? ""} className={INPUT_CLASS} />
          </Field>
          <Field label="of" htmlFor={`${hid}-edition`}>
            <input id={`${hid}-edition`} name="serialEdition" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} defaultValue={view.edition} className={INPUT_CLASS} />
          </Field>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {fixing ? (
          <>
            <Button type="submit" name="answer" value="fix" disabled={pending} className="flex-1" aria-label={`Save the serial number of ${title}`}>Save</Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setFixing(false)}>Cancel</Button>
          </>
        ) : (
          <>
            {view.weak ? null : <Button type="submit" name="answer" value="yes" disabled={pending} className="flex-1" aria-label={`Yes, ${read} is the serial number of ${title}`}>Yes</Button>}
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setFixing(true)}>Fix it</Button>
          </>
        )}
        <Button type="submit" name="answer" value="no" variant="secondary" disabled={pending} className="flex-1" formNoValidate aria-label={`${title} has no serial number`}>No serial number</Button>
      </div>
      {state.message ? <div role="alert"><Notice tone="danger">{state.message}</Notice></div> : null}
    </form>
  );
}
