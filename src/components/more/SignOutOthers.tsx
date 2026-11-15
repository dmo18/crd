"use client";

import { useActionState } from "react";
import { signOutOtherDevices, type SignOutOthersState } from "@/lib/auth/actions";
import { Button, Card, Notice } from "@/components/ui";

const initial: SignOutOthersState = { error: null, done: false };

/** Owner only (the More page calls requireOwner first). */
export function SignOutOthers() {
  const [state, formAction, pending] = useActionState(signOutOtherDevices, initial);
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Other devices</h2>
      <p className="text-sm text-muted">
        Signs out every other phone and computer, for example one you lost or sold. Your password stays the same. This one stays signed in.
      </p>
      <form action={formAction}>
        <Button type="submit" variant="secondary" disabled={pending} className="w-full">
          {pending ? "Signing out..." : "Sign out all other devices"}
        </Button>
      </form>
      {state.error ? <div role="alert"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.done ? <div role="status"><Notice tone="accent">Done. Every other phone and computer is now signed out.</Notice></div> : null}
    </Card>
  );
}
