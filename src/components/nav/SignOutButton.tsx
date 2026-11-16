"use client";

import { useScanQueue } from "@/components/items/ScanQueueProvider";
import { hasUnsaved, maySignOut } from "@/components/items/scan-queue";
import { Button } from "@/components/ui";
import { logout } from "@/lib/auth/actions";

/** Sign out. Asks first when photos on the scan list are not saved yet, because signing out loses them. */
export function SignOutButton() {
  const { state } = useScanQueue();
  const unsaved = hasUnsaved(state);
  return (
    <form
      action={logout}
      onSubmit={(e) => {
        if (!maySignOut(unsaved, (q) => window.confirm(q))) e.preventDefault();
      }}
    >
      <Button type="submit" variant="secondary">Sign out</Button>
    </form>
  );
}
