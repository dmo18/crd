"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/lib/auth/actions";
import { Button, Card, Field, INPUT_CLASS, Notice } from "@/components/ui";

const initial: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initial);
  return (
    <Card>
      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={200}
            className={INPUT_CLASS}
          />
        </Field>
        {state.error ? (
          <div role="alert">
            <Notice tone="danger">{state.error}</Notice>
          </div>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
