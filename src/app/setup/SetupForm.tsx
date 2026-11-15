"use client";

import { useActionState } from "react";
import { setupOwner, type SetupState } from "@/lib/auth/actions";
import { Button, Card, Field, INPUT_CLASS, Notice } from "@/components/ui";

const initial: SetupState = { error: null };

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupOwner, initial);
  return (
    <Card>
      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Setup code" htmlFor="code">
          <input
            id="code" name="code" type="password" autoComplete="off" required maxLength={200}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="New password" hint="At least 16 characters. A few random words works well." htmlFor="password">
          <input
            id="password" name="password" type="password" autoComplete="new-password" required
            minLength={16} maxLength={200} className={INPUT_CLASS}
          />
        </Field>
        <Field label="New password again" htmlFor="confirm">
          <input
            id="confirm" name="confirm" type="password" autoComplete="new-password" required
            minLength={16} maxLength={200} className={INPUT_CLASS}
          />
        </Field>
        {state.error ? (
          <div role="alert">
            <Notice tone="danger">{state.error}</Notice>
          </div>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save password and sign in"}
        </Button>
      </form>
    </Card>
  );
}
