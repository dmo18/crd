"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/lib/auth/actions";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";

const initial: ChangePasswordState = { error: null, done: false };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePassword, initial);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Current password" htmlFor="current-password">
        <input
          id="current-password" name="current" type="password" autoComplete="current-password" required
          maxLength={200} className={INPUT_CLASS}
        />
      </Field>
      <Field label="New password" hint="At least 16 characters." htmlFor="new-password">
        <input
          id="new-password" name="password" type="password" autoComplete="new-password" required
          minLength={16} maxLength={200} className={INPUT_CLASS}
        />
      </Field>
      <Field label="New password again" htmlFor="new-password-again">
        <input
          id="new-password-again" name="confirm" type="password" autoComplete="new-password" required
          minLength={16} maxLength={200} className={INPUT_CLASS}
        />
      </Field>
      {state.error ? (
        <div role="alert">
          <Notice tone="danger">{state.error}</Notice>
        </div>
      ) : null}
      {state.done ? (
        <div role="status">
          <Notice tone="accent">Password changed. Other phones and computers are now signed out.</Notice>
        </div>
      ) : null}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving..." : "Change password"}
      </Button>
    </form>
  );
}
