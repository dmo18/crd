"use client";

import { useActionState, type ReactNode } from "react";
import { Button, Field, INPUT_CLASS, Notice } from "@/components/ui";
import type { Item, ItemKind } from "@/db/schema";
import { CONDITIONS, PRODUCT_TYPES, RARITY_TIERS, SEAL_STATES, SPORTS } from "@/db/schema";
import { createItemAction, saveItemAction, type SaveState } from "@/lib/items/actions";
import { readRookie, ROOKIE_STATE_LABELS } from "@/lib/items/rookie";
import { splitSerial } from "@/lib/items/serial";
import { ROOKIE_STATES } from "@/db/schema";
import { CONDITION_LABELS, PRODUCT_LABELS, RARITY_LABELS, SEAL_LABELS, SPORT_LABELS } from "@/lib/items/labels";

const FLAGS = [
  ["isError", "Error card"],
  ["isParallel", "Parallel"],
  ["isInsert", "Insert"],
  ["isAutograph", "Autograph"],
  ["isMemorabilia", "Memorabilia (jersey, bat, etc.)"],
] as const;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Select<T extends string>({ id, name, value, values, labels }: {
  id: string; name: string; value: T | null; values: readonly T[]; labels: Record<T, string>;
}) {
  return (
    <select id={id} name={name} defaultValue={value ?? ""} className={INPUT_CLASS}>
      <option value="">Not set</option>
      {values.map((v) => <option key={v} value={v}>{labels[v]}</option>)}
    </select>
  );
}

const INITIAL: SaveState = { status: "idle", errors: {} };

/** An empty record the new item form starts from. */
function blankItem(kind: ItemKind): Item {
  return {
    id: 0, kind, quantity: 1, status: "confirmed", title: "", sport: null, year: null, yearEnd: null, brand: null, setName: null,
    cardNumber: null, player: null, team: null, variation: null, isRookie: false, isError: false, isParallel: false,
    isInsert: false, isAutograph: false, isMemorabilia: false, serialNumber: null, rarityTier: null, condition: null,
    conditionNotes: null, grader: null, grade: null, certNumber: null, productType: null, packCount: null, sealState: null,
    estCount: null, containerType: null, description: null, locationId: null, notes: null, manualValueCents: null,
  } as unknown as Item;
}

/** Edits `item`, or (with `create`) makes a new record of that kind by hand. */
export function ItemForm({ item: given, create, locations = [], check = [] }: {
  item?: Item; create?: ItemKind; locations?: { id: number; name: string }[];
  /** Fields the reader filled without being sure: marked "Check this". */
  check?: readonly string[];
}) {
  const item = given ?? blankItem(create ?? "card");
  const [state, action, pending] = useActionState(create ? createItemAction : saveItemAction, INITIAL);
  const e = state.errors;
  const isCard = item.kind === "card";
  const rookie = readRookie(item);
  const serialParts = item.serialEdition ? { copy: item.serialCopy, edition: item.serialEdition } : splitSerial(item.serialNumber);
  const wholeSerial = !serialParts && !!item.serialNumber;
  const isSealed = item.kind === "sealed";
  const isBulk = item.kind === "bulk";

  const text = (name: keyof Item, label: string, opts: { hint?: string; inputMode?: "numeric" | "decimal"; max?: number } = {}) => {
    const v = item[name];
    return (
      <Field label={label} hint={opts.hint} error={e[name]} htmlFor={`f-${name}`} check={check.includes(name)}>
        <input
          id={`f-${name}`} name={name} type="text" defaultValue={v == null ? "" : String(v)}
          inputMode={opts.inputMode} maxLength={opts.max} className={INPUT_CLASS}
          aria-invalid={e[name] ? true : undefined}
        />
      </Field>
    );
  };

  return (
    <form action={action} className="flex flex-col gap-6">
      {create ? <input type="hidden" name="kind" value={create} /> : <input type="hidden" name="id" value={item.id} />}

      <Group title="What it is">
        <Field label="Sport" error={e.sport} htmlFor="f-sport" check={check.includes("sport")}>
          <Select id="f-sport" name="sport" value={item.sport} values={SPORTS} labels={SPORT_LABELS} />
        </Field>
        {text("year", isBulk ? "First year" : "Year", { inputMode: "numeric", max: 4 })}
        {isBulk ? text("yearEnd", "Last year", { inputMode: "numeric", max: 4 }) : null}
        {text("brand", "Brand", { max: 80 })}
        {text("setName", "Set", { max: 120 })}
        {isCard ? text("cardNumber", "Card number", { max: 30 }) : null}
        {isCard ? text("player", "Player", { max: 120 }) : null}
        {isCard ? text("team", "Team", { max: 80 }) : null}
        {text("variation", "Variation", { hint: "Parallel, insert or subset name, if any.", max: 120 })}
        {isSealed ? (
          <>
            <Field label="Product type" error={e.productType} htmlFor="f-productType">
              <Select id="f-productType" name="productType" value={item.productType} values={PRODUCT_TYPES} labels={PRODUCT_LABELS} />
            </Field>
            {text("packCount", "Number of packs", { inputMode: "numeric", max: 6 })}
            <Field label="Seal" error={e.sealState} htmlFor="f-sealState">
              <Select id="f-sealState" name="sealState" value={item.sealState} values={SEAL_STATES} labels={SEAL_LABELS} />
            </Field>
          </>
        ) : null}
        {isBulk ? text("containerType", "Container", { hint: "For example: shoebox or binder.", max: 80 }) : null}
        <Field label="Description" hint={create ? "Your own words, if you do not know the player or set." : undefined} error={e.description} htmlFor="f-description">
          <textarea id="f-description" name="description" rows={3} maxLength={600} defaultValue={item.description ?? ""} className={`${INPUT_CLASS} py-2`} />
        </Field>
      </Group>

      <Group title="Rarity">
        <Field label="Rarity" error={e.rarityTier} htmlFor="f-rarityTier">
          <Select id="f-rarityTier" name="rarityTier" value={item.rarityTier} values={RARITY_TIERS} labels={RARITY_LABELS} />
        </Field>
        {isCard ? (
          <>
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-sm font-semibold">This card is a</legend>
              {FLAGS.map(([name, label]) => (
                <label key={name} className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" name={name} defaultChecked={item[name]} className="size-5 accent-accent" />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-sm font-semibold">Rookie card?</legend>
              {rookie.source === "key_list" && rookie.note ? <p className="pb-1 text-sm text-muted">{rookie.note}</p> : null}
              {!create && !rookie.sourceRecorded && rookie.state === "yes" ? <p className="pb-1 text-sm text-muted">Source not recorded.</p> : null}
              <div className="grid grid-cols-2 gap-2">
                {ROOKIE_STATES.map((v) => (
                  <label key={v} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface-2 px-3">
                    <input type="radio" name="rookieState" value={v} defaultChecked={rookie.state === v} className="size-5 accent-accent" />
                    <span>{ROOKIE_STATE_LABELS[v]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-sm font-semibold">Serial number</legend>
              <p className="pb-1 text-sm text-muted">Only if the card is numbered, like 045 of 100. Keep the zeros.</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Copy" error={e.serialCopy} htmlFor="f-serialCopy">
                  <input id="f-serialCopy" name="serialCopy" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} defaultValue={serialParts?.copy ?? ""} className={INPUT_CLASS} />
                </Field>
                <Field label="of" error={e.serialEdition} htmlFor="f-serialEdition">
                  <input id="f-serialEdition" name="serialEdition" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} defaultValue={serialParts?.edition ?? ""} className={INPUT_CLASS} />
                </Field>
              </div>
              {wholeSerial ? text("serialNumber", "Serial number as written", { hint: "This older note does not fit the two boxes, so it is kept as it is.", max: 30 }) : null}
            </fieldset>
          </>
        ) : null}
      </Group>

      <Group title="Condition">
        {isCard ? (
          <>
            <Field label="Condition" error={e.condition} htmlFor="f-condition">
              <Select id="f-condition" name="condition" value={item.condition} values={CONDITIONS} labels={CONDITION_LABELS} />
            </Field>
            {text("grader", "Grading company", { hint: "Only if the card is in a graded holder, like PSA.", max: 20 })}
            {text("grade", "Grade", { max: 20 })}
            {text("certNumber", "Certificate number", { max: 40 })}
          </>
        ) : null}
        <Field label="Condition notes" error={e.conditionNotes} htmlFor="f-conditionNotes">
          <textarea id="f-conditionNotes" name="conditionNotes" rows={2} maxLength={400} defaultValue={item.conditionNotes ?? ""} className={`${INPUT_CLASS} py-2`} />
        </Field>
      </Group>

      <Group title="Value and count">
        {isBulk ? text("estCount", "Estimated number of cards", { inputMode: "numeric", max: 8 }) : null}
        {text("quantity", "How many you have", { inputMode: "numeric", max: 6 })}
        <Field label="Your value" hint="Dollars for one. Leave empty to use the AI estimate." error={e.manualValue} htmlFor="f-manualValue">
          <input
            id="f-manualValue" name="manualValue" type="text" inputMode="decimal" maxLength={14}
            defaultValue={item.manualValueCents == null ? "" : (item.manualValueCents / 100).toFixed(2)}
            className={INPUT_CLASS} aria-invalid={e.manualValue ? true : undefined}
          />
        </Field>
      </Group>

      <Group title="Where it is">
        <Field label="Stored in" error={e.locationId} htmlFor="f-locationId">
          <select id="f-locationId" name="locationId" defaultValue={item.locationId == null ? "" : String(item.locationId)} className={INPUT_CLASS}>
            <option value="">No location</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      </Group>

      <Group title="Notes">
        <Field label="Your notes" error={e.notes} htmlFor="f-notes">
          <textarea id="f-notes" name="notes" rows={3} maxLength={600} defaultValue={item.notes ?? ""} className={`${INPUT_CLASS} py-2`} />
        </Field>
      </Group>

      {e.form ? <div role="alert"><Notice tone="danger">{e.form}</Notice></div> : null}
      <div aria-live="polite">
        {state.status === "saved" && !create ? <Notice tone="accent">Saved</Notice> : null}
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Saving..." : create ? "Save" : "Save changes"}</Button>
    </form>
  );
}
