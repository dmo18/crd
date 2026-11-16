"use client";

import { useActionState, useState } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import {
  clearAnswersAction, removeKeyAction, saveKeyAction, switchSourceAction, testConnectionAction,
  type ConnectionActionState,
} from "@/lib/outside/actions";

/**
 * The buttons of one source on More, Connections. Each form sends only the
 * source id (and, for a key, the pasted key once). The server answers with
 * fixed plain words; nothing it sends back holds the key.
 */

const initial: ConnectionActionState = { ok: null, message: null };

function Answer({ state }: { state: ConnectionActionState }) {
  if (!state.message) return null;
  return state.ok
    ? <div role="status"><Notice tone="accent">{state.message}</Notice></div>
    : <div role="alert"><Notice tone="danger">{state.message}</Notice></div>;
}

export function SwitchForm({ source, name, enabled }: { source: string; name: string; enabled: boolean }) {
  const [state, action, pending] = useActionState(switchSourceAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="on" value={enabled ? "0" : "1"} />
      <Button type="submit" variant="secondary" disabled={pending} className="w-full" aria-label={`${enabled ? "Switch off" : "Switch on"} ${name}`}>
        {pending ? "Saving..." : enabled ? "Switch off" : "Switch on"}
      </Button>
      <Answer state={state} />
    </form>
  );
}

export function TestForm({ source, name }: { source: string; name: string }) {
  const [state, action, pending] = useActionState(testConnectionAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="source" value={source} />
      <Button type="submit" variant="secondary" disabled={pending} className="w-full" aria-label={`Test ${name}`}>
        {pending ? "Testing..." : "Test"}
      </Button>
      <Answer state={state} />
    </form>
  );
}

export function ClearForm({ source, name }: { source: string; name: string }) {
  const [state, action, pending] = useActionState(clearAnswersAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="source" value={source} />
      <Button type="submit" variant="secondary" disabled={pending} className="w-full" aria-label={`Clear stored answers of ${name}`}>
        {pending ? "Clearing..." : "Clear stored answers"}
      </Button>
      <Answer state={state} />
    </form>
  );
}

/** Paste a key once. The field is a password field and is empty again after saving. */
export function KeyForm({ source, name, hint, replacing }: { source: string; name: string; hint: string; replacing: boolean }) {
  const [state, action, pending] = useActionState(saveKeyAction, initial);
  const id = `key-${source}`;
  return (
    <form action={action} className="flex flex-col gap-2" autoComplete="off">
      <input type="hidden" name="source" value={source} />
      <Field label={replacing ? `New key for ${name}` : `Key for ${name}`} hint={hint} htmlFor={id}>
        <input
          id={id} name="key" type="password" required minLength={16} maxLength={200}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className={INPUT_CLASS}
        />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Saving..." : "Save key"}</Button>
      <Answer state={state} />
    </form>
  );
}

export function RemoveKeyForm({ source, name }: { source: string; name: string }) {
  const [state, action, pending] = useActionState(removeKeyAction, initial);
  const [asking, setAsking] = useState(false);
  if (!asking && !state.message) {
    return <Button type="button" variant="danger" className="w-full" onClick={() => setAsking(true)}>Remove key</Button>;
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="source" value={source} />
      {state.message ? <Answer state={state} /> : (
        <>
          <p className="text-sm">Remove the key of {name}? The app stops using this connection until you save a new one.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" onClick={() => setAsking(false)}>Keep it</Button>
            <Button type="submit" variant="danger" disabled={pending}>{pending ? "Removing..." : "Remove"}</Button>
          </div>
        </>
      )}
    </form>
  );
}

/** Saved key: Replace opens the paste field again. */
export function ReplaceKey({ source, name, hint }: { source: string; name: string; hint: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button type="button" variant="secondary" className="w-full" onClick={() => setOpen(true)}>Replace key</Button>;
  return (
    <div className="flex flex-col gap-2">
      <KeyForm source={source} name={name} hint={hint} replacing />
      <Button type="button" variant="ghost" className="w-full" onClick={() => setOpen(false)}>Close</Button>
    </div>
  );
}
