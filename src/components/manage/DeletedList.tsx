"use client";

import { LocalTime } from "@/components/activity/LocalTime";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import { emptyBinAction, purgeItemsAction, restoreItemsAction } from "@/lib/items/bulk-actions";

export type BinRow = { id: number; title: string; thumb: string | null; deletedAt: number; left: string };
type Ask = "restore" | "forever" | "empty" | null;

const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

export function DeletedList({ rows, total, page, pageCount, prev, next }: {
  rows: BinRow[]; total: number; page: number; pageCount: number; prev: string | null; next: string | null;
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<number[]>([]);
  const [ask, setAsk] = useState<Ask>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  const onPage = ticked.filter((id) => rows.some((r) => r.id === id));
  const allTicked = rows.length > 0 && onPage.length === rows.length;
  const n = onPage.length;

  const open = (a: Ask) => { setAsk(a); setSure(false); setMessage(null); };

  async function go() {
    setBusy(true);
    try {
      const r = ask === "restore" ? await restoreItemsAction(onPage) : ask === "forever" ? await purgeItemsAction(onPage) : await emptyBinAction();
      if ("error" in r) setMessage({ text: r.error, bad: true });
      else if ("restored" in r) setMessage({ text: `Restored ${items(r.restored)}. They are back in your collection.`, bad: false });
      else setMessage({ text: `Removed ${items(r.removed)} for good.`, bad: false });
      setTicked([]);
    } catch {
      setMessage({ text: "Could not reach the server. Nothing was changed. Try again.", bad: true });
    } finally {
      setBusy(false);
      setAsk(null);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {message ? <Notice tone={message.bad ? "danger" : "accent"}><span role="status">{message.text}</span></Notice> : null}

      <Button type="button" variant="secondary" onClick={() => setTicked(allTicked ? ticked.filter((id) => !rows.some((r) => r.id === id)) : [...new Set([...ticked, ...rows.map((r) => r.id)])])}>
        {allTicked ? "Unselect this page" : "Select this page"}
      </Button>

      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id} className="flex items-stretch gap-2">
            <label className="flex size-11 shrink-0 items-center justify-center self-center">
              <input type="checkbox" aria-label={`Select ${r.title}`} checked={ticked.includes(r.id)}
                onChange={() => setTicked(ticked.includes(r.id) ? ticked.filter((x) => x !== r.id) : [...ticked, r.id])} className="size-6 accent-accent" />
            </label>
            <Link href={`/items/${r.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border bg-surface p-3">
              {r.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/images/${r.thumb}`} alt={`Photo of ${r.title}`} className="size-16 shrink-0 rounded-lg bg-surface-2 object-cover" />
              ) : <div aria-hidden="true" className="size-16 shrink-0 rounded-lg bg-surface-2" />}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="font-semibold break-words">{r.title}</p>
                <p className="text-sm text-muted">Deleted <LocalTime ms={r.deletedAt} /></p>
                <p className="text-sm text-muted">{r.left.startsWith("Removed") ? r.left : `${r.left} left`}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {pageCount > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3">
          {prev ? <Link href={prev} className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface-2 px-4 font-semibold">Previous</Link> : <span className="min-w-24" />}
          <p className="text-sm text-muted">Page {page} of {pageCount}</p>
          {next ? <Link href={next} className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface-2 px-4 font-semibold">Next</Link> : <span className="min-w-24" />}
        </nav>
      ) : null}

      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
        <p className="text-sm font-semibold" role="status">{n === 0 ? "Tick items above to restore them or remove them for good." : `${items(n)} selected on this page.`}</p>
        {ask === null ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" disabled={n === 0} onClick={() => open("restore")}>Restore{n ? ` ${items(n)}` : ""}</Button>
            <Button type="button" variant="danger" disabled={n === 0} onClick={() => open("forever")}>Delete forever{n ? ` (${n})` : ""}</Button>
            <Button type="button" variant="danger" className="sm:col-span-2" onClick={() => open("empty")}>Empty the bin ({total.toLocaleString("en-US")})</Button>
          </div>
        ) : ask === "restore" ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm font-semibold">Restore {items(n)}? They come back with their photos and value history.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" disabled={busy} onClick={() => void go()}>{busy ? "Working" : `Yes, restore ${items(n)}`}</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsk(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-danger bg-danger-soft p-3">
            <p role="alert" className="text-base font-bold text-danger">
              {ask === "empty" ? `Remove all ${items(total)} in the bin for good?` : `Remove ${items(n)} for good?`}
            </p>
            <p className="text-sm">Their photos and value history are removed too. This cannot be undone and you cannot bring them back.</p>
            <label htmlFor="bin-sure" className="flex min-h-11 items-center gap-3 text-base font-semibold">
              <input id="bin-sure" type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="size-6 accent-danger" />
              Yes, I understand
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" variant="danger" disabled={busy || !sure} onClick={() => void go()}>
                {busy ? "Removing" : ask === "empty" ? `Empty the bin (${items(total)})` : `Delete ${items(n)} forever`}
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsk(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
