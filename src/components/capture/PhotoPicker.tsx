"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { canDecode, shrinkPhoto } from "./shrink";

type Props = {
  label: string;
  max?: number;
  value: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  captureFirst?: boolean;
};

const BUTTON_STYLE =
  "inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-xl border px-4 text-base font-semibold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent";

export function PhotoPicker({ label, max = 1, value, onChange, disabled = false, captureFirst = false }: Props) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const full = value.length >= max;
  const locked = disabled || busy || full;

  // One object URL per file, revoked when the file leaves the list or on unmount.
  const urls = useMemo(() => value.map((f) => URL.createObjectURL(f)), [value]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  async function handleFiles(list: FileList | null, input: HTMLInputElement) {
    const picked = list ? Array.from(list) : [];
    input.value = "";
    if (picked.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const added: File[] = [];
      let unreadable = false;
      for (const file of picked) {
        if (valueRef.current.length + added.length >= max) break;
        const shrunk = await shrinkPhoto(file);
        if (shrunk === file && !(await canDecode(file))) {
          unreadable = true;
          continue;
        }
        added.push(shrunk);
      }
      if (added.length > 0) onChange([...valueRef.current, ...added]);
      if (unreadable) setError("That file is not a photo we can read.");
    } finally {
      setBusy(false);
    }
  }

  function remove(index: number) {
    setError(null);
    onChange(value.filter((_, i) => i !== index));
  }

  const takeId = `${id}-take`;
  const libraryId = `${id}-library`;
  const buttonLook = (primary: boolean) =>
    `${BUTTON_STYLE} ${primary ? "border-transparent bg-accent text-accent-text" : "border-border bg-surface-2 text-text"} ${
      locked ? "pointer-events-none opacity-50" : ""
    }`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold">{label}</p>

      <div className="flex flex-wrap gap-2">
        <label htmlFor={takeId} className={buttonLook(captureFirst)}>
          Take photo
          <input
            id={takeId}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={locked}
            onChange={(e) => void handleFiles(e.target.files, e.target)}
          />
        </label>
        <label htmlFor={libraryId} className={buttonLook(!captureFirst)}>
          Choose from library
          <input
            id={libraryId}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple={max > 1}
            className="sr-only"
            disabled={locked}
            onChange={(e) => void handleFiles(e.target.files, e.target)}
          />
        </label>
      </div>

      {busy ? (
        <p role="status" className="text-sm text-muted">Preparing photo...</p>
      ) : null}
      {full && !busy ? (
        <p className="text-sm text-muted">
          {max === 1 ? "Photo added. Remove it to pick another." : `You have added the most photos allowed (${max}).`}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

      {value.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3">
          {value.map((file, i) => (
            <li key={`${file.name}-${file.lastModified}-${i}`} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-2">
              {/* Plain img: this is a local blob URL, which next/image cannot optimize. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={urls[i]} alt={`Photo ${i + 1}`} className="aspect-[3/4] w-full rounded-lg bg-surface-2 object-cover" />
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={disabled}
                onClick={() => remove(i)}
                aria-label={`Remove photo ${i + 1}`}
              >
                Remove photo {i + 1}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
