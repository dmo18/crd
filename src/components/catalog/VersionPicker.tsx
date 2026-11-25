"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, Card, Field, INPUT_CLASS } from "@/components/ui";
import { chooseVersionAction, showVersionsAction, type VersionActionState } from "@/lib/catalog/version-actions";
import type { VersionView } from "@/lib/catalog/version-view";

const NONE: VersionActionState = { message: null };

/**
 * "Which version is it?" The app suggests, the owner chooses: "Show versions"
 * only lists the choices and the evidence; "Save" sends the id, the place in
 * the list the server stored and the time of that list, never the option itself.
 */
export function VersionPicker({ itemId, title, view }: { itemId: number; title: string; view: VersionView }) {
  const [shown, show, showing] = useActionState(showVersionsAction, NONE);
  const [saved, save, saving] = useActionState(chooseVersionAction, NONE);
  const message = saved.message ?? shown.message;
  return (
    <section id="version" className="scroll-mt-4" aria-labelledby="version-heading">
      <Card className="flex flex-col gap-3">
        <h2 id="version-heading" className="text-lg font-semibold">Which version is it?</h2>
        <p className={view.assumed ? "text-sm font-semibold break-words" : "text-sm break-words"}>{view.stateLine}</p>
        {view.several ? <p className="text-sm font-semibold">There is more than one version of this card.</p> : null}
        <form action={show}>
          <input type="hidden" name="id" value={itemId} />
          <Button type="submit" variant={view.list ? "secondary" : "primary"} className="w-full" disabled={showing} aria-label={`Show versions of ${title}`}>
            {showing ? "Looking..." : "Show versions"}
          </Button>
        </form>
        {view.list ? (
          <form action={save} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={itemId} />
            <input type="hidden" name="listAt" value={view.list.at} />
            {view.list.catalogLine ? <p className="text-sm text-muted">{view.list.catalogLine}</p> : null}
            {view.list.options.some((o) => o.evidence.some((e) => e.url)) ? <p className="text-sm text-muted">Catalog entries below are from MyCardfolio.</p> : null}
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 text-sm font-semibold">{view.assumed ? "The normal version is selected for now. Tap Save to keep it, or pick another" : "Pick one, then tap Save"}</legend>
              {view.list.options.map((o) => (
                <div key={o.position} className="flex flex-col gap-1 rounded-xl border border-border bg-surface-2 p-3">
                  <label htmlFor={`version-${o.position}`} className="flex min-h-11 items-center gap-3 text-base font-semibold">
                    <input id={`version-${o.position}`} type="radio" name="position" value={o.position} required defaultChecked={view.assumed && o.kind === "base"} className="size-6 shrink-0 accent-accent" />
                    <span className="break-words">{o.name}</span>
                  </label>
                  {o.evidence.map((e, i) => (
                    <p key={i} className="pl-9 text-sm text-muted break-words">
                      {e.text}
                      {e.url ? (
                        <>
                          {" "}
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-accent underline">
                            Open in the catalog (new tab)
                          </a>
                        </>
                      ) : null}
                    </p>
                  ))}
                  {o.kind === "another" ? (
                    <div className="pl-9">
                      <Field label="Name of the version" htmlFor="version-text" hint="2 to 120 characters. Only used when you pick Another version.">
                        <input id="version-text" name="text" type="text" maxLength={120} className={INPUT_CLASS} autoComplete="off" />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ))}
            </fieldset>
            <Button type="submit" className="w-full" disabled={saving} aria-label={`Save the version of ${title}`}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </form>
        ) : null}
        {message ? <p role="status" className="text-sm font-semibold">{message}</p> : null}
        <p className="text-xs text-muted">Not sure yet is a fine answer. Nothing changes until you tap Save.</p>
      </Card>
    </section>
  );
}

/** Review: the short way into the picker on the item page. */
export function ChooseVersionLink({ itemId, title }: { itemId: number; title: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-3">
      <p className="text-sm font-semibold">There is more than one version of this card.</p>
      <Link href={`/items/${itemId}#version`} aria-label={`Choose the version of ${title}`}
        className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-base font-semibold text-text">
        Choose the version
      </Link>
    </div>
  );
}
