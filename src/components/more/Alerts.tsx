"use client";

import { useActionState } from "react";
import { sendTestAlertAction, type TestAlertState } from "@/lib/alerts-actions";
import { Button, Card, Notice } from "@/components/ui";

const initial: TestAlertState = { ok: null, message: null };

/**
 * Owner only (the More page calls requireOwner first). `channels` holds only
 * names like "Telegram", never the settings themselves.
 */
export function Alerts({ channels }: { channels: string[] }) {
  const [state, formAction, pending] = useActionState(sendTestAlertAction, initial);
  const on = channels.length > 0;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Alerts</h2>
      <p className="text-sm text-muted">
        A message to your phone when someone keeps guessing your password, signs in on a new device, changes the password, or when scans keep failing.
      </p>
      <Notice tone={on ? "accent" : "neutral"}>
        {on
          ? `Alerts are on. They go to ${channels.join(" and ")}.`
          : "Alerts are off. They can go to Telegram or Discord. Ask whoever runs the server to turn them on."}
      </Notice>
      <form action={formAction}>
        <Button type="submit" variant="secondary" disabled={pending} className="w-full">
          {pending ? "Sending..." : "Send a test alert"}
        </Button>
      </form>
      {state.ok === false && state.message ? <div role="alert"><Notice tone="danger">{state.message}</Notice></div> : null}
      {state.ok === true && state.message ? <div role="status"><Notice tone="accent">{state.message}</Notice></div> : null}
    </Card>
  );
}
