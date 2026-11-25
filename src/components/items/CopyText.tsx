"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/** A button that copies some words, for sites whose address cannot carry them. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="secondary" onClick={copy}>{label}</Button>
      <p aria-live="polite" className="text-sm text-muted break-words">
        {state === "copied" ? "Copied. Paste it into the site's search box." : state === "failed" ? `Copy did not work. The words are: ${text}` : ""}
      </p>
    </div>
  );
}
