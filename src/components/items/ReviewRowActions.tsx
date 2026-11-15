"use client";

import { useState } from "react";
import { Button, LinkButton } from "@/components/ui";
import { confirmFromReviewAction, deleteFromReviewAction } from "@/lib/items/review-actions";

export function ReviewRowActions({ id, title }: { id: number; title: string }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <form action={deleteFromReviewAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={id} />
        <p role="alert" className="text-sm font-semibold">Delete this item and its photos? This cannot be undone.</p>
        <div className="flex gap-2">
          <Button type="submit" variant="danger" aria-label={`Yes, delete ${title}`} className="flex-1">Yes, delete</Button>
          <Button type="button" variant="secondary" className="flex-1" onClick={() => setAsking(false)}>Cancel</Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex gap-2">
      <form action={confirmFromReviewAction} className="flex-1">
        <input type="hidden" name="id" value={id} />
        <Button type="submit" aria-label={`Confirm ${title}`} className="w-full">Confirm</Button>
      </form>
      <LinkButton href={`/items/${id}`} variant="secondary" aria-label={`Edit ${title}`} className="flex-1">Edit</LinkButton>
      <Button type="button" variant="danger" aria-label={`Delete ${title}`} className="flex-1" onClick={() => setAsking(true)}>Delete</Button>
    </div>
  );
}
