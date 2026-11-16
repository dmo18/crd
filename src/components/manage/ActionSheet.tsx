"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import { CONDITIONS, ITEM_STATUSES, RARITY_TIERS, SPORTS } from "@/db/schema";
import { applyBulkAction, previewBulkAction } from "@/lib/items/bulk-actions";
import { CONDITION_LABELS, RARITY_LABELS, SPORT_LABELS } from "@/lib/items/labels";

export type SheetKind = "set" | "replace" | "move" | "status" | "delete";
export type Done = { changed: number; summary: string; kind: SheetKind };
type Preview = { count: number; samples: { id: number; title: string; before: string; after: string }[] };

const FLAGS = ["isRookie", "isError", "isParallel", "isInsert", "isAutograph", "isMemorabilia"] as const;
const SET_FIELDS: [string, string][] = [
  ["sport", "Sport"], ["year", "Year"], ["brand", "Brand"], ["setName", "Set name"], ["cardNumber", "Card number"],
  ["player", "Player"], ["team", "Team"], ["variation", "Variation"], ["condition", "Condition"], ["rarityTier", "Rarity"],
  ["isRookie", "Rookie"], ["isError", "Error card"], ["isParallel", "Parallel"], ["isInsert", "Insert"],
  ["isAutograph", "Autograph"], ["isMemorabilia", "Memorabilia"], ["quantity", "Quantity"], ["notes", "Notes"],
  ["manualValue", "Your own value"],
];
const REPLACE_FIELDS: [string, string][] = [
  ["player", "Player"], ["team", "Team"], ["brand", "Brand"], ["setName", "Set name"], ["variation", "Variation"],
  ["cardNumber", "Card number"], ["notes", "Notes"], ["description", "Description"],
];
const TEXT_FIELDS = ["brand", "setName", "cardNumber", "player", "team", "variation", "notes"];
const NO_CLEAR = [...FLAGS, "quantity"] as string[];

const TITLES: Record<SheetKind, string> = {
  set: "Set a field", replace: "Find and replace", move: "Move to a location", status: "Mark as checked or needs review", delete: "Delete",
};
const items = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`;

export function ActionSheet({ kind, selection, count, locations, onClose, onDone }: {
  kind: SheetKind;
  selection: unknown;
  count: number;
  locations: { id: number; name: string }[];
  onClose: () => void;
  onDone: (d: Done) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [field, setField] = useState("player");
  const [value, setValue] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [clear, setClear] = useState(false);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [locationId, setLocationId] = useState("none");
  const [status, setStatus] = useState<(typeof ITEM_STATUSES)[number]>("confirmed");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const isFlag = (FLAGS as readonly string[]).includes(field);
  const changeField = (f: string) => {
    setField(f);
    setValue((FLAGS as readonly string[]).includes(f) ? "yes" : "");
    setOnlyEmpty(TEXT_FIELDS.includes(f));
    setClear(false);
  };

  function buildAction(): unknown {
    switch (kind) {
      case "set": {
        if (isFlag) return { type: "set", field, value: value !== "no", onlyEmpty };
        return { type: "set", field, value: clear ? "" : value, onlyEmpty: clear ? false : onlyEmpty };
      }
      case "replace": return { type: "replace", field, find, replace, matchCase };
      case "move": return { type: "move", locationId: locationId === "none" ? null : Number(locationId) };
      case "status": return { type: "status", status };
      case "delete": return { type: "delete" };
    }
  }

  async function run<T>(fn: () => Promise<T | { error: string }>, ok: (r: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "error" in r) setError(String((r as { error: string }).error));
      else ok(r as T);
    } catch {
      setError("Could not reach the server. Nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const doPreview = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => previewBulkAction({ selection, action: buildAction() }), (r: Preview) => setPreview(r));
  };
  const doApply = () =>
    void run(() => applyBulkAction({ selection, action: buildAction() }), (r: { changed: number; summary: string }) =>
      onDone({ changed: r.changed, summary: r.summary, kind }));

  const idp = `sheet-${kind}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${idp}-title`}
      onClose={onClose}
      onCancel={(e) => { if (busy) e.preventDefault(); }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-text backdrop:bg-text/40"
    >
      <h2 id={`${idp}-title`} className="pb-1 text-xl font-bold">{TITLES[kind]}</h2>
      <p className="pb-3 text-sm text-muted">{items(count)} selected.</p>

      {preview ? (
        <div className="flex flex-col gap-3">
          {preview.count === 0 ? (
            <Notice tone="warn">Nothing would change. Every selected item already matches.</Notice>
          ) : (
            <>
              <p className="text-base font-semibold" role="status">
                {kind === "delete" ? `${items(preview.count)} will be deleted.` : `${items(preview.count)} will change.`}
              </p>
              {kind === "delete" ? (
                <Notice tone="warn">Deleted items go to Recently deleted for 30 days. You can bring them back from there, then they are removed for good.</Notice>
              ) : null}
              {preview.samples.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {preview.samples.map((s) => (
                    <li key={s.id} className="rounded-xl bg-surface-2 p-3 text-sm">
                      <p className="font-semibold break-words">{s.title}</p>
                      <p className="break-words text-muted">Before: {s.before}</p>
                      <p className="break-words">After: {s.after}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {preview.count > preview.samples.length ? <p className="text-sm text-muted">Showing {preview.samples.length} examples.</p> : null}
            </>
          )}
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            {preview.count > 0 ? (
              <Button type="button" variant={kind === "delete" ? "danger" : "primary"} disabled={busy} onClick={doApply}>
                {busy ? "Working" : kind === "delete" ? `Delete ${items(preview.count)}` : `Change ${items(preview.count)}`}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={busy} onClick={() => { setPreview(null); setError(null); }}>Back</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={doPreview} className="flex flex-col gap-3">
          {kind === "set" ? (
            <>
              <Field label="Field" htmlFor={`${idp}-field`}>
                <select id={`${idp}-field`} value={field} onChange={(e) => changeField(e.target.value)} className={INPUT_CLASS}>
                  {SET_FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <ValueInput id={`${idp}-value`} field={field} value={value} onChange={setValue} disabled={clear} />
              {!NO_CLEAR.includes(field) ? (
                <Check id={`${idp}-clear`} checked={clear} onChange={setClear} label="Clear this field" />
              ) : null}
              <Check id={`${idp}-empty`} checked={onlyEmpty && !clear} disabled={clear} onChange={setOnlyEmpty} label="Only fill where empty" />
            </>
          ) : null}
          {kind === "replace" ? (
            <>
              <Field label="Field" htmlFor={`${idp}-field`}>
                <select id={`${idp}-field`} value={field} onChange={(e) => setField(e.target.value)} className={INPUT_CLASS}>
                  {REPLACE_FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Find this text" htmlFor={`${idp}-find`}>
                <input id={`${idp}-find`} value={find} onChange={(e) => setFind(e.target.value)} maxLength={100} required className={INPUT_CLASS} />
              </Field>
              <Field label="Replace with" htmlFor={`${idp}-replace`} hint="Leave empty to remove the found text.">
                <input id={`${idp}-replace`} value={replace} onChange={(e) => setReplace(e.target.value)} maxLength={100} className={INPUT_CLASS} />
              </Field>
              <Check id={`${idp}-case`} checked={matchCase} onChange={setMatchCase} label="Match capital letters" />
            </>
          ) : null}
          {kind === "move" ? (
            <Field label="Location" htmlFor={`${idp}-loc`}>
              <select id={`${idp}-loc`} value={locationId} onChange={(e) => setLocationId(e.target.value)} className={INPUT_CLASS}>
                <option value="none">No location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          ) : null}
          {kind === "status" ? (
            <Field label="Mark them as" htmlFor={`${idp}-status`}>
              <select id={`${idp}-status`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={INPUT_CLASS}>
                <option value="confirmed">Checked</option>
                <option value="needs_review">Needs review</option>
              </select>
            </Field>
          ) : null}
          {kind === "delete" ? (
            <Notice tone="warn">Deleted items go to Recently deleted for 30 days. You can bring them back from there.</Notice>
          ) : null}
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <p className="text-sm text-muted">Next you see how many items would change. Nothing changes until you confirm.</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="submit" variant={kind === "delete" ? "danger" : "primary"} disabled={busy}>{busy ? "Checking" : "See what would change"}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

function Check({ id, checked, onChange, label, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-base font-semibold">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-6 accent-accent" />
      {label}
    </label>
  );
}

function ValueInput({ id, field, value, onChange, disabled }: { id: string; field: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const select = (opts: [string, string][], any: string) => (
    <Field label="New value" htmlFor={id}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={INPUT_CLASS}>
        <option value="">{any}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </Field>
  );
  if (field === "sport") return select(SPORTS.map((s) => [s, SPORT_LABELS[s]]), "Choose a sport");
  if (field === "condition") return select(CONDITIONS.map((s) => [s, CONDITION_LABELS[s]]), "Choose a condition");
  if (field === "rarityTier") return select(RARITY_TIERS.map((s) => [s, RARITY_LABELS[s]]), "Choose a rarity");
  if ((FLAGS as readonly string[]).includes(field)) {
    return (
      <Field label="New value" htmlFor={id}>
        <select id={id} value={value || "yes"} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </Field>
    );
  }
  const numeric = field === "year" || field === "quantity";
  return (
    <Field label="New value" htmlFor={id} hint={field === "manualValue" ? "In dollars, like 12.50." : undefined}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} maxLength={600}
        inputMode={numeric ? "numeric" : field === "manualValue" ? "decimal" : "text"} className={INPUT_CLASS} />
    </Field>
  );
}
