"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/** "Copy the missing list": plain text to the clipboard, with a fallback for browsers that refuse. */
export function CopyMissing({ text, count }: { text: string; count: number }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      return;
    } catch {
      // Older browsers: copy from a hidden text box.
    }
    try {
      const box = document.createElement("textarea");
      box.value = text;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      setState(ok ? "copied" : "failed");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="secondary" onClick={copy} className="w-full">Copy the missing list</Button>
      <p aria-live="polite" className="text-sm text-muted">
        {state === "copied" ? `Copied ${count.toLocaleString("en-US")} ${count === 1 ? "card" : "cards"}. Paste it into a message or a note.` : null}
      </p>
      {state === "failed" ? (
        <textarea readOnly value={text} rows={6} aria-label="The missing list" className="w-full rounded-xl border border-border bg-surface p-2 text-sm" />
      ) : null}
      {state === "failed" ? <p className="text-sm text-muted">Copy did not work here. Press and hold the text above to copy it.</p> : null}
    </div>
  );
}
