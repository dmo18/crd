"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { UndoNotice, type UndoOffer } from "@/components/manage/UndoNotice";
import { Button } from "@/components/ui";
import { applyBulkAction } from "@/lib/items/bulk-actions";
import { confirmReviewItemsAction } from "@/lib/items/review-actions";
import type { ReviewGroupId } from "@/lib/items/review-groups";

export type ReviewRowView = {
  id: number;
  title: string;
  thumb: string | null;
  /** The value line, for example "Est. $4.00" or "No value yet". */
  value: string;
  /** Labels of the fields marked "Check this". */
  check: string[];
  reasons: string[];
};

export type ReviewGroupView = { id: ReviewGroupId; title: string; help: string; rows: ReviewRowView[] };

const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

/** The words after "Confirm selected": what happened, and that Undo takes it back. */
export function confirmedLine(n: number): string {
  return `Confirmed ${items(n)} as read. Their Check this marks are cleared. Undo below takes it back.`;
}

/**
 * Review in three groups, with ticks, "Select all in this group", and
 * "Confirm selected" or "Delete selected" for every ticked item at once.
 * Each is one change in the Manage history, so one Undo takes it back.
 */
export function ReviewGroups({ groups, details, undo }: { groups: ReviewGroupView[]; details: Record<number, ReactNode>; undo: UndoOffer | null }) {
  const router = useRouter();
  const [ticked, setTicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = new Set(groups.flatMap((g) => g.rows.map((r) => r.id)));
  // Items that left the list (confirmed or deleted elsewhere) drop out of the selection.
  const selected = ticked.filter((id) => shown.has(id));
  const isTicked = (id: number) => selected.includes(id);
  const toggle = (id: number) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  function toggleGroup(g: ReviewGroupView) {
    const ids = g.rows.map((r) => r.id);
    const all = ids.every((id) => selected.includes(id));
    setTicked((t) => (all ? t.filter((x) => !ids.includes(x)) : [...new Set([...t, ...ids])]));
  }

  async function run(kind: "confirm" | "delete") {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = kind === "confirm"
        ? await confirmReviewItemsAction(selected)
        : await applyBulkAction({ selection: { ids: selected }, action: { type: "delete" } });
      if ("error" in r) setError(r.error);
      else {
        setTicked([]);
        setMessage(kind === "confirm" ? confirmedLine(r.changed) : `Deleted ${items(r.changed)}. They are in Recently deleted for 30 days. Undo below brings them back.`);
      }
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setBusy(false);
      setAskDelete(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <UndoNotice offer={undo} message={message} onUndone={() => setMessage(null)} />
      {error ? <p role="alert" className="rounded-2xl border border-danger p-3 text-sm text-danger">{error}</p> : null}

      {groups.map((g) => {
        const allTicked = g.rows.length > 0 && g.rows.every((r) => isTicked(r.id));
        return (
          <section key={g.id} aria-labelledby={`group-${g.id}`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id={`group-${g.id}`} className="text-lg font-semibold">{g.title} ({g.rows.length})</h2>
              <p className="text-sm text-muted">{g.help}</p>
            </div>
            {g.rows.length === 0 ? (
              <p className="text-sm text-muted">None right now.</p>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={() => toggleGroup(g)}>
                  {allTicked ? "Unselect this group" : "Select all in this group"}
                </Button>
                <ul className="flex flex-col gap-3">
                  {g.rows.map((r) => (
                    <li key={r.id} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-2">
                      <div className="flex items-start gap-1">
                        <label className="flex size-11 shrink-0 items-center justify-center">
                          <input type="checkbox" aria-label={`Select ${r.title}`} checked={isTicked(r.id)} onChange={() => toggle(r.id)}
                            className="size-6 accent-accent" />
                        </label>
                        <Link href={`/items/${r.id}`} className="flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-xl p-1">
                          {r.thumb ? (
                            // Plain img: photos come from our own /api/images route, already resized.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/api/images/${r.thumb}`} alt={`Photo of ${r.title}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-contain" />
                          ) : (
                            <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />
                          )}
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <p className="font-semibold break-words">{r.title}</p>
                            <p className="text-sm text-muted">{r.value}</p>
                            {r.check.length > 0 ? <p className="text-sm font-semibold text-warn break-words">Check this: {r.check.join(", ")}</p> : null}
                            {r.reasons.length > 0 ? (
                              <ul className="flex flex-col gap-0.5 text-sm break-words">
                                {r.reasons.map((why) => <li key={why}>{why}</li>)}
                              </ul>
                            ) : null}
                          </div>
                        </Link>
                      </div>
                      {details[r.id] ? (
                        <details className="rounded-xl border border-border">
                          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold text-accent">More for this card</summary>
                          <div className="flex flex-col gap-3 p-3 pt-0">{details[r.id]}</div>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        );
      })}

      {selected.length > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-xl border-t border-border bg-surface p-3 shadow-lg lg:max-w-3xl lg:rounded-t-2xl lg:border">
          {askDelete ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm font-semibold">Delete {items(selected.length)}? They go to Recently deleted for 30 days.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="danger" disabled={busy} onClick={() => void run("delete")}>{busy ? "Deleting" : "Yes, delete"}</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setAskDelete(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold" role="status">{items(selected.length)} selected</p>
                <Button type="button" variant="ghost" onClick={() => setTicked([])}>Clear</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" disabled={busy} onClick={() => void run("confirm")}>{busy ? "Confirming" : "Confirm selected"}</Button>
                <Button type="button" variant="danger" disabled={busy} onClick={() => setAskDelete(true)}>Delete selected</Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {selected.length > 0 ? <div aria-hidden="true" className="h-40" /> : null}
    </div>
  );
}
