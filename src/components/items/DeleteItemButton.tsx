"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { deleteItemAction } from "@/lib/items/actions";

export function DeleteItemButton({ id }: { id: number }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <Button type="button" variant="danger" onClick={() => setAsking(true)}>Delete this item</Button>;
  }
  return (
    <form action={deleteItemAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <p role="alert" className="text-sm font-semibold">Delete this item? It goes to Recently deleted. You can bring it back for 30 days, then it is removed for good.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="submit" variant="danger">Yes, delete it</Button>
        <Button type="button" variant="secondary" onClick={() => setAsking(false)}>Cancel</Button>
      </div>
    </form>
  );
}
