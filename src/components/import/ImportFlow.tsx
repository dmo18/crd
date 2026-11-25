"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, Field, INPUT_CLASS, LinkButton, Notice } from "@/components/ui";
import { undoBulkAction } from "@/lib/items/bulk-actions";
import { CSV_MESSAGES, MAX_CSV_BYTES, parseCsv } from "@/lib/import/csv";
import { guessMapping, IMPORT_FIELD_LABELS, IMPORT_FIELDS, SKIP, type ColumnChoice } from "@/lib/import/fields";
import type { DuplicateChoice, ImportPreview, ImportResult } from "@/lib/import/plan";

type Step = "pick" | "match" | "preview" | "done";
type FileData = { text: string; header: string[]; samples: string[][]; rowCount: number };

const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
const DUPLICATE_LABELS: Record<DuplicateChoice, string> = {
  skip: "Skip them (keep what you have)",
  new: "Add them as new items",
  add: "Add to the quantity of the one you have",
};

async function send(file: FileData, body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const form = new FormData();
  form.set("text", file.text);
  form.set("request", JSON.stringify(body));
  try {
    const res = await fetch("/api/import", { method: "POST", body: form });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok || !data) return { ok: false, error: data?.error ?? "Something went wrong. Nothing was saved. Try again." };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Could not reach the server. Nothing was saved. Try again." };
  }
}

export function ImportFlow() {
  const [step, setStep] = useState<Step>("pick");
  const [file, setFile] = useState<FileData | null>(null);
  const [pasted, setPasted] = useState("");
  const [mapping, setMapping] = useState<ColumnChoice[]>([]);
  const [otherSport, setOtherSport] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateChoice>("skip");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<"idle" | "asking" | "busy" | string>("idle");

  function read(text: string) {
    setError(null);
    const r = parseCsv(text);
    if (!r.ok) { setError(r.error); return; }
    setFile({ text, header: r.header, samples: r.rows.slice(0, 2), rowCount: r.rows.length });
    setMapping(guessMapping(r.header));
    setStep("match");
  }

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(f.name)) { setError("This is a spreadsheet file, not CSV. Save your spreadsheet as CSV first, then pick that file."); return; }
    if (f.size > MAX_CSV_BYTES) { setError(CSV_MESSAGES.tooBig); return; }
    try {
      read(await f.text());
    } catch {
      setError("This file could not be read. Save your spreadsheet as CSV first, then try again.");
    }
  }

  const options = { unknownSportOther: otherSport, duplicates };

  async function check() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const r = await send(file, { step: "check", mapping, options });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setPreview(r.data as ImportPreview);
    setStep("preview");
    window.scrollTo(0, 0);
  }

  async function apply() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    const r = await send(file, { step: "apply", mapping, options, skipProblems: preview.counts.problems > 0, expected: preview.counts });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setResult(r.data as ImportResult);
    setStep("done");
    window.scrollTo(0, 0);
  }

  async function undoImport() {
    if (!result) return;
    setUndo("busy");
    try {
      const r = await undoBulkAction(result.opId);
      setUndo("error" in r ? r.error : `Undone. ${n(r.restored, "item")} put back as they were${r.skipped > 0 ? `, ${n(r.skipped, "item")} left alone because they changed since` : ""}. Added items are in Recently deleted.`);
    } catch {
      setUndo("Could not reach the server. Nothing was undone.");
    }
  }

  const errorBox = error ? <Notice tone="danger"><span role="alert">{error}</span></Notice> : null;

  if (step === "pick") {
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Step 1 of 4: pick the file</h2>
          <p className="text-sm text-muted">
            Save your spreadsheet as CSV first. In Excel or Numbers use Save As or Export and pick CSV; in Google Sheets use
            File, Download, CSV. Up to 5 MB and 20,000 rows. A file this app exported can be brought back in to update the same items.
          </p>
          <Field label="CSV file" htmlFor="import-file">
            <input id="import-file" type="file" accept=".csv,text/csv,text/plain" className={`${INPUT_CLASS} py-2`}
              onChange={(e) => void pickFile(e.target.files?.[0])} />
          </Field>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Or paste the text</h2>
          <Field label="CSV text, with the header row first" htmlFor="import-paste">
            <textarea id="import-paste" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)}
              className={`${INPUT_CLASS} py-2 font-mono text-sm`} placeholder={"Player,Year,Brand\nKen Griffey Jr.,1989,Upper Deck"} />
          </Field>
          <Button type="button" variant="secondary" disabled={pasted.trim() === ""} onClick={() => read(pasted)}>Use this text</Button>
        </Card>
        {errorBox}
      </div>
    );
  }

  if (step === "match" && file) {
    const chosen = new Map<ColumnChoice, number>();
    mapping.forEach((m) => chosen.set(m, (chosen.get(m) ?? 0) + 1));
    const twice = [...chosen].filter(([m, c]) => m !== SKIP && c > 1).map(([m]) => IMPORT_FIELD_LABELS[m as keyof typeof IMPORT_FIELD_LABELS]);
    const none = mapping.every((m) => m === SKIP || m === "id");
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Step 2 of 4: match the columns</h2>
          <p className="text-sm text-muted">{n(file.rowCount, "row")} found. For each column of your file, pick where it goes in the app, or Do not import. The first guess comes from the header words.</p>
        </Card>
        <ul className="flex flex-col gap-3">
          {file.header.map((h, i) => (
            <li key={i}>
              <Card className="flex flex-col gap-2">
                <p className="font-semibold break-words">{h || `Column ${i + 1} (no header)`}</p>
                <p className="text-sm text-muted break-words">
                  {file.samples.map((r) => r[i]).filter((v) => v && v.trim() !== "").map((v) => v.slice(0, 60)).join(" · ") || "Empty in the first rows"}
                </p>
                <Field label={`Goes to`} htmlFor={`map-${i}`}>
                  <select id={`map-${i}`} className={INPUT_CLASS} value={mapping[i]}
                    onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value as ColumnChoice : m)))}>
                    <option value={SKIP}>Do not import</option>
                    {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{IMPORT_FIELD_LABELS[f]}</option>)}
                  </select>
                </Field>
              </Card>
            </li>
          ))}
        </ul>
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Choices</h2>
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={otherSport} onChange={(e) => setOtherSport(e.target.checked)} className="size-6 accent-accent" />
            <span>Unknown sports become Other</span>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-semibold">Rows that look like one you already have (same year, brand, card number and player)</legend>
            {(Object.keys(DUPLICATE_LABELS) as DuplicateChoice[]).map((d) => (
              <label key={d} className="flex min-h-11 items-center gap-3">
                <input type="radio" name="duplicates" value={d} checked={duplicates === d} onChange={() => setDuplicates(d)} className="size-6 accent-accent" />
                <span>{DUPLICATE_LABELS[d]}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted">
            How values are read: spaces at the ends are removed; $1,234.50 becomes your value of 1,234.50 dollars; Yes, Y, true and x mean yes;
            No, N and false mean no; sport and condition words match with any capitals (NM, EX and VG too); a season such as 1993-94 becomes 1993.
            A row with an ID from this app&apos;s export updates that item; only the columns you match here change.
          </p>
        </Card>
        {twice.length > 0 ? <Notice tone="warn">Each place can take one column only. Used twice: {twice.join(", ")}.</Notice> : null}
        {errorBox}
        <div className="flex flex-col gap-2">
          <Button type="button" disabled={busy || twice.length > 0 || none} onClick={() => void check()}>{busy ? "Checking every row" : "Check the rows"}</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { setStep("pick"); setError(null); }}>Pick another file</Button>
        </div>
      </div>
    );
  }

  if (step === "preview" && preview) {
    const c = preview.counts;
    const saving = c.added + c.updated;
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Step 3 of 4: check before saving</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">New items</dt><dd className="text-right font-semibold">{c.added.toLocaleString("en-US")}</dd>
            <dt className="text-muted">Items updated</dt><dd className="text-right font-semibold">{c.updated.toLocaleString("en-US")}</dd>
            <dt className="text-muted">Rows with no change</dt><dd className="text-right font-semibold">{c.unchanged.toLocaleString("en-US")}</dd>
            <dt className="text-muted">Looks like one you already have</dt><dd className="text-right font-semibold">{c.duplicates.toLocaleString("en-US")}</dd>
            <dt className="text-muted">Rows with problems</dt><dd className={`text-right font-semibold ${c.problems > 0 ? "text-danger" : ""}`}>{c.problems.toLocaleString("en-US")}</dd>
          </dl>
          {preview.newLocations.length > 0 ? (
            <p className="text-sm">New locations will be made: {preview.newLocations.slice(0, 20).join(", ")}{preview.newLocations.length > 20 ? ` and ${preview.newLocations.length - 20} more` : ""}.</p>
          ) : null}
        </Card>

        {preview.problems.length > 0 ? (
          <Card className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Problems</h2>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {preview.problems.map((p, i) => <li key={i} className="break-words">{p.message}</li>)}
            </ul>
            {preview.problems.length < c.problems ? <p className="text-sm text-muted">Only the first problems are listed.</p> : null}
          </Card>
        ) : null}

        {preview.duplicates.length > 0 ? (
          <Card className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Looks like one you already have</h2>
            <p className="text-sm text-muted">Chosen: {DUPLICATE_LABELS[duplicates]}.</p>
            <ul className="flex flex-col gap-2 text-sm">
              {preview.duplicates.map((d) => (
                <li key={d.row} className="break-words">
                  Row {d.row}: {d.title}. You have <Link href={`/items/${d.matchId}`} className="text-accent underline">{d.matchTitle}</Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">The first rows, as they will be saved</h2>
          <ul className="flex flex-col gap-2">
            {preview.rows.map((r) => (
              <li key={r.row} className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted">Row {r.row}</span>
                  <Badge tone={r.action === "Add" || r.action === "Add as new" ? "accent" : r.action === "Update" || r.action === "Add to quantity" ? "gold" : "neutral"}>{r.action}</Badge>
                </div>
                <p className="font-semibold break-words">{r.title}</p>
                {r.details ? <p className="text-sm text-muted break-words">{r.details}</p> : null}
              </li>
            ))}
          </ul>
        </Card>

        {errorBox}
        <div className="flex flex-col gap-2">
          {saving > 0 ? (
            <Button type="button" disabled={busy} onClick={() => void apply()}>
              {busy ? "Saving" : c.problems > 0
                ? `Import the good rows and skip the ${n(c.problems, "row")} with problems`
                : `Save: ${n(c.added, "new item")}, ${n(c.updated, "update")}`}
            </Button>
          ) : <Notice tone="warn">Nothing to save: no row adds or changes an item.</Notice>}
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { setStep("match"); setError(null); }}>Go back</Button>
        </div>
      </div>
    );
  }

  if (step === "done" && result) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Step 4 of 4: done</h2>
          <p role="status">Added {n(result.added, "item")} and updated {n(result.updated, "item")}.{result.skipped > 0 ? ` Skipped ${n(result.skipped, "row")}.` : ""}</p>
        </Card>
        {result.addedItems.length > 0 ? <ChangeList title="Added" list={result.addedItems} total={result.added} /> : null}
        {result.updatedItems.length > 0 ? <ChangeList title="Changed" list={result.updatedItems} total={result.updated} /> : null}
        <Card className="flex flex-col gap-2">
          <p className="text-sm text-muted">Changed your mind? Undo puts updated items back as they were and moves the added ones to Recently deleted. You can also undo it later from Manage records, as long as it is the latest change.</p>
          {undo === "idle" ? <Button type="button" variant="secondary" onClick={() => setUndo("asking")}>Undo this import</Button> : null}
          {undo === "asking" ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm font-semibold">Undo this import?</p>
              <Button type="button" onClick={() => void undoImport()}>Yes, undo it</Button>
              <Button type="button" variant="secondary" onClick={() => setUndo("idle")}>Keep it</Button>
            </div>
          ) : null}
          {undo === "busy" ? <p role="status" className="text-sm">Undoing</p> : null}
          {undo !== "idle" && undo !== "asking" && undo !== "busy" ? <Notice tone="accent"><span role="status">{undo}</span></Notice> : null}
          <LinkButton href="/manage" variant="secondary">Go to Manage records</LinkButton>
          <LinkButton href="/items" variant="secondary">See the inventory</LinkButton>
        </Card>
      </div>
    );
  }
  return null;
}

function ChangeList({ title, list, total }: { title: string; list: { id: number; title: string }[]; total: number }) {
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="flex flex-col">
        {list.map((i) => (
          <li key={i.id}><Link href={`/items/${i.id}`} className="inline-flex min-h-11 items-center text-accent underline break-words">{i.title}</Link></li>
        ))}
      </ul>
      {total > list.length ? <p className="text-sm text-muted">And {(total - list.length).toLocaleString("en-US")} more.</p> : null}
    </Card>
  );
}
