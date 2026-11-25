"use client";

import { useRef, type ReactNode } from "react";
import { Button, LinkButton } from "@/components/ui";

/**
 * The "Filters" button and the sheet it opens. The fields are passed in and
 * stay inside the page's search form, so "Show results" sends them all in the
 * link. Closing the sheet without pressing it changes nothing.
 */
export function FilterSheet({ count, clearHref, children }: { count: number; clearHref: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <Button type="button" variant="secondary" className="w-full" aria-haspopup="dialog" onClick={() => ref.current?.showModal()}>
        {count > 0 ? `Filters (${count} on)` : "Filters"}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby="filter-sheet-title"
        className="m-auto max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface p-0 text-text backdrop:bg-text/40 open:flex"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h2 id="filter-sheet-title" className="text-xl font-bold">Filters{count > 0 ? ` (${count} on)` : ""}</h2>
          <Button type="button" variant="ghost" onClick={() => ref.current?.close()}>Close</Button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">{children}</div>
        <div className="grid grid-cols-2 gap-3 border-t border-border bg-surface px-4 py-3">
          <Button type="submit">Show results</Button>
          <LinkButton href={clearHref} variant="secondary">Clear all</LinkButton>
        </div>
      </dialog>
    </>
  );
}
