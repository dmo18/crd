"use client";

import { useActionState, useRef, useState } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import {
  createLocationAction, deleteLocationAction, renameLocationAction, type LocationFormState,
} from "@/lib/locations/actions";
import { LOCATION_KINDS } from "@/lib/locations/kinds";

const INITIAL: LocationFormState = { status: "idle", errors: {} };

function Fields({ idPrefix, errors, defaults }: {
  idPrefix: string; errors: Record<string, string>; defaults?: { name: string; kind: string | null; notes: string | null };
}) {
  return (
    <>
      <Field label="Name" error={errors.name} htmlFor={`${idPrefix}-name`}>
        <input
          id={`${idPrefix}-name`} name="name" type="text" maxLength={60} required defaultValue={defaults?.name ?? ""}
          placeholder="For example: Box 1" className={INPUT_CLASS} aria-invalid={errors.name ? true : undefined}
        />
      </Field>
      <Field label="Kind" error={errors.kind} htmlFor={`${idPrefix}-kind`}>
        <select id={`${idPrefix}-kind`} name="kind" defaultValue={defaults?.kind ?? ""} className={INPUT_CLASS}>
          <option value="">Not set</option>
          {LOCATION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>
      <Field label="Notes (optional)" error={errors.notes} htmlFor={`${idPrefix}-notes`}>
        <textarea
          id={`${idPrefix}-notes`} name="notes" rows={2} maxLength={300} defaultValue={defaults?.notes ?? ""}
          className={`${INPUT_CLASS} py-2`}
        />
      </Field>
    </>
  );
}

export function AddLocationForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: LocationFormState, formData: FormData) => {
    const next = await createLocationAction(prev, formData);
    if (next.status === "saved") formRef.current?.reset();
    return next;
  }, INITIAL);
  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3">
      <Fields idPrefix="add" errors={state.errors} />
      {state.errors.form ? <div role="alert"><Notice tone="danger">{state.errors.form}</Notice></div> : null}
      <div aria-live="polite">{state.status === "saved" ? <Notice tone="accent">Location added</Notice> : null}</div>
      <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add location"}</Button>
    </form>
  );
}

export function EditLocationForm({ location }: { location: { id: number; name: string; kind: string | null; notes: string | null } }) {
  const [state, action, pending] = useActionState(renameLocationAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3 pt-3">
      <input type="hidden" name="id" value={location.id} />
      <Fields idPrefix={`edit-${location.id}`} errors={state.errors} defaults={location} />
      {state.errors.form ? <div role="alert"><Notice tone="danger">{state.errors.form}</Notice></div> : null}
      <div aria-live="polite">{state.status === "saved" ? <Notice tone="accent">Saved</Notice> : null}</div>
      <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save changes"}</Button>
    </form>
  );
}

export function DeleteLocationButton({ id, name }: { id: number; name: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="secondary" onClick={() => setConfirming(true)} aria-label={`Delete ${name}`}>
        Delete
      </Button>
    );
  }
  return (
    <form action={deleteLocationAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <p className="text-sm">Delete {name}? Items stay in your inventory.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger">Yes, delete</Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Keep it</Button>
      </div>
    </form>
  );
}
