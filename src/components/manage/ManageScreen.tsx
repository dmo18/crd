"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { endSentence } from "@/lib/title";
import { ActionSheet, type Done, type SheetKind } from "./ActionSheet";
import { ExportLink } from "./ExportLink";
import { MAX_TICKED, useSelection } from "./selection";
import { UndoNotice, type UndoOffer } from "./UndoNotice";

export type ManageRow = {
  id: number; title: string; year: number | null; brand: string | null; cardNumber: string | null;
  player: string | null; team: string | null; location: string | null; value: string;
  needsReview: boolean; thumb: string | null;
};

const MAX_ITEMS = 5000;
const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;
const ACTIONS: [SheetKind, string][] = [
  ["set", "Set a field"], ["replace", "Find and replace"], ["move", "Move to a location"],
  ["status", "Mark checked or needs review"], ["delete", "Delete"],
];

export function ManageScreen({ rows, total, page, pageCount, pageLinks, filterKey, filters, exportQuery, locations, undo }: {
  rows: ManageRow[]; total: number; page: number; pageCount: number;
  pageLinks: { prev: string | null; next: string | null };
  filterKey: string; filters: Record<string, unknown>;
  /** Link query of the current filters, for the export. */
  exportQuery: string;
  locations: { id: number; name: string }[];
  undo: UndoOffer | null;
}) {
  const router = useRouter();
  const sel = useSelection();
  const { setFilterKey } = sel;
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [limitNote, setLimitNote] = useState<string | null>(null);

  useEffect(() => { setFilterKey(filterKey); }, [filterKey, setFilterKey]);

  const count = sel.all ? total : sel.ids.size;
  const pageIds = rows.map((r) => r.id);
  const pageAllTicked = pageIds.length > 0 && pageIds.every((id) => sel.all || sel.ids.has(id));
  const tooMany = total > MAX_ITEMS;

  const tick = (id: number) => {
    setLimitNote(null);
    if (!sel.toggle(id)) setLimitNote(`You can tick up to ${MAX_TICKED} items one by one. Use "Select all ${total.toLocaleString("en-US")} matching" for more.`);
  };
  const selectPage = () => {
    setLimitNote(null);
    if (!sel.addMany(pageIds)) setLimitNote(`You can tick up to ${MAX_TICKED} items one by one. Use "Select all ${total.toLocaleString("en-US")} matching" for more.`);
  };
  const selection = sel.all ? { filters, expectedCount: total } : { ids: [...sel.ids] };

  function done(d: Done) {
    setSheet(null);
    setMenu(false);
    sel.clear();
    setMessage(d.kind === "delete"
      ? `Deleted ${items(d.changed)}. They are in Recently deleted for 30 days.`
      : endSentence(`Changed ${items(d.changed)}: ${d.summary}`));
    router.refresh();
  }

  return (
    <>
      <UndoNotice offer={undo} message={message} />

      <div className="flex flex-col gap-2 pb-3">
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={() => (pageAllTicked ? sel.removeMany(pageIds) : selectPage())} disabled={sel.all || rows.length === 0}>
            {pageAllTicked ? "Unselect this page" : "Select this page"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => { setLimitNote(null); sel.selectAll(); }} disabled={sel.all || tooMany || total === 0}>
            Select all {total.toLocaleString("en-US")} matching
          </Button>
        </div>
        {tooMany ? <p className="text-sm text-muted">That is more than {MAX_ITEMS.toLocaleString("en-US")} items. Narrow the search to change them all at once.</p> : null}
        {limitNote ? <p role="alert" className="text-sm text-danger">{limitNote}</p> : null}
        {sel.all ? <p className="text-sm font-semibold" role="status">All {items(total)} matching are selected, on every page.</p> : null}
        {!sel.all && sel.ids.size > 0
          ? <ExportLink query={`ids=${[...sel.ids].sort((a, b) => a - b).join(",")}`} label={`Export the ${items(sel.ids.size)} selected`} />
          : <ExportLink query={exportQuery} label="Export what I am looking at" />}
      </div>

      <div className="lg:relative lg:left-1/2 lg:w-[min(72rem,calc(100vw-3rem))] lg:-translate-x-1/2">
        {/* Phone: a list. */}
        <ul className="flex flex-col gap-3 lg:hidden">
          {rows.map((r) => (
            <li key={r.id} className="flex items-stretch gap-2">
              <label className="flex size-11 shrink-0 items-center justify-center self-center">
                <input type="checkbox" aria-label={`Select ${r.title}`} checked={sel.all || sel.ids.has(r.id)} disabled={sel.all}
                  onChange={() => tick(r.id)} className="size-6 accent-accent" />
              </label>
              <Link href={`/items/${r.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border bg-surface p-3">
                <Thumb file={r.thumb} title={r.title} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="font-semibold break-words">{r.title}</p>
                  <p className="text-sm text-muted break-words">{[r.player, r.year, r.location ? `In ${r.location}` : null].filter(Boolean).join(" · ") || "No details yet"}</p>
                  <p className="text-sm text-muted">{r.value}{r.needsReview ? " · Needs review" : ""}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {/* Wide screens: a table. */}
        <div className="hidden overflow-x-auto rounded-2xl border border-border bg-surface lg:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Your records. Tick a row to select it, or open the title to see the item.</caption>
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th scope="col" className="w-12 px-2 py-2"><span className="sr-only">Select</span></th>
                <th scope="col" className="w-16 px-2 py-2"><span className="sr-only">Photo</span></th>
                {["Title", "Year", "Brand", "Number", "Player", "Team", "Location", "Value", "Status"].map((h) => (
                  <th key={h} scope="col" className="px-2 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-surface-2" onClick={() => router.push(`/items/${r.id}`)}>
                  <td className="px-2" onClick={(e) => e.stopPropagation()}>
                    <label className="flex size-11 items-center justify-center">
                      <input type="checkbox" aria-label={`Select ${r.title}`} checked={sel.all || sel.ids.has(r.id)} disabled={sel.all}
                        onChange={() => tick(r.id)} className="size-6 accent-accent" />
                    </label>
                  </td>
                  <td className="px-2 py-1"><Thumb file={r.thumb} title={r.title} small /></td>
                  <td className="max-w-64 px-2 py-1 font-semibold">
                    <Link href={`/items/${r.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex min-h-11 items-center text-accent underline break-words">{r.title}</Link>
                  </td>
                  <td className="px-2 tabular">{r.year ?? ""}</td>
                  <td className="px-2">{r.brand ?? ""}</td>
                  <td className="px-2">{r.cardNumber ?? ""}</td>
                  <td className="px-2">{r.player ?? ""}</td>
                  <td className="px-2">{r.team ?? ""}</td>
                  <td className="px-2">{r.location ?? ""}</td>
                  <td className="px-2 whitespace-nowrap tabular">{r.value}</td>
                  <td className="px-2">{r.needsReview ? <Badge tone="warn">Needs review</Badge> : <Badge tone="accent">Checked</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageCount > 1 ? (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-4">
            {pageLinks.prev ? <Link href={pageLinks.prev} className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface-2 px-4 font-semibold">Previous</Link> : <span className="min-w-24" />}
            <p className="text-sm text-muted">Page {page} of {pageCount}</p>
            {pageLinks.next ? <Link href={pageLinks.next} className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface-2 px-4 font-semibold">Next</Link> : <span className="min-w-24" />}
          </nav>
        ) : null}
      </div>

      {count > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-xl border-t border-border bg-surface p-3 shadow-lg lg:max-w-3xl lg:rounded-t-2xl lg:border">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold" role="status">{items(count)} selected</p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => sel.clear()}>Clear</Button>
              <Button type="button" id="manage-actions-button" aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? "Hide actions" : "Actions"}</Button>
            </div>
          </div>
          {menu ? (
            <ul className="grid grid-cols-1 gap-2 pt-3 sm:grid-cols-2">
              {ACTIONS.map(([k, label]) => (
                <li key={k}>
                  <Button type="button" variant={k === "delete" ? "danger" : "secondary"} className="w-full" onClick={() => setSheet(k)}>{label}</Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {count > 0 ? <div aria-hidden="true" className="h-40" /> : null}

      {sheet ? (
        <ActionSheet key={sheet} kind={sheet} selection={selection} count={count} locations={locations}
          onClose={() => setSheet(null)} onDone={done} />
      ) : null}
    </>
  );
}

function Thumb({ file, title, small }: { file: string | null; title: string; small?: boolean }) {
  const size = small ? "size-11" : "size-16";
  return file ? (
    // Plain img: photos come from our own /api/images route, already resized.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/images/${file}`} alt={`Photo of ${title}`} className={`${size} shrink-0 rounded-lg bg-surface-2 object-contain`} />
  ) : (
    <div aria-hidden="true" className={`${size} shrink-0 rounded-lg bg-surface-2`} />
  );
}
