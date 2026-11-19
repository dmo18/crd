"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhotoPicker } from "@/components/capture/PhotoPicker";
import { Button } from "@/components/ui";

type Props =
  | { itemId: number; mode: "add"; role: "front" | "back"; title: string }
  | { itemId: number; mode: "replace"; imageId: number; title: string };

/** Add a front or back photo later, or replace one. The browser shrinks it first; the server checks it again. */
export function PhotoUpload(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("mode", props.mode);
      if (props.mode === "add") form.set("role", props.role);
      else form.set("imageId", String(props.imageId));
      form.set("photo", file, "photo.jpg");
      const res = await fetch(`/api/items/${props.itemId}/photos`, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save the photo. Try again.");
        return;
      }
      setFiles([]);
      setOpen(false);
      router.refresh();
    } catch {
      setError("The photo did not arrive. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button type="button" variant="secondary" className="w-full" onClick={() => setOpen(true)}>{props.title}</Button>;
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <PhotoPicker label={props.title} max={1} value={files} onChange={setFiles} disabled={busy} />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {busy ? <p role="status" className="text-sm text-muted">Saving the photo...</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" disabled={busy || files.length === 0} onClick={() => void save()}>Save this photo</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setOpen(false); setFiles([]); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}
