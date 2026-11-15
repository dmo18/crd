"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { deleteFailedScansAction } from "@/lib/items/review-actions";

export function DeleteFailedScans({ count }: { count: number }) {
  const [asking, setAsking] = useState(false);
  const what = count === 1 ? "1 scan that did not work" : `${count} scans that did not work`;
  if (!asking) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">You have {what}. Their photos still take up space.</p>
        <Button type="button" variant="secondary" onClick={() => setAsking(true)}>Delete failed scans</Button>
      </div>
    );
  }
  return (
    <form action={deleteFailedScansAction} className="flex flex-col gap-2">
      <p role="alert" className="text-sm font-semibold">Delete {what} and their photos? This cannot be undone.</p>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" className="flex-1">Yes, delete</Button>
        <Button type="button" variant="secondary" className="flex-1" onClick={() => setAsking(false)}>Cancel</Button>
      </div>
    </form>
  );
}
