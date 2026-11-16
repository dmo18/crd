/** How often the pill and the Scan activity page ask the server while scans are being read. */
export const STATUS_POLL_MS = 5000;

/**
 * When to ask the server again, in ms, or null for "do not ask on a timer".
 * Only asks while something is being read and the tab is on screen. The pill
 * still asks once when a page loads, when the tab comes back, and when the
 * scan screen saves a photo; those are not timers.
 */
export function nextStatusAskMs(reading: number, hidden: boolean): number | null {
  if (hidden || reading <= 0) return null;
  return STATUS_POLL_MS;
}

export type StatusCounts = { reading: number; failed: number; toReview: number };

/** Accepts only a well-formed answer from the status route. */
export function parseCounts(data: unknown): StatusCounts | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!ok(d.reading) || !ok(d.failed) || !ok(d.toReview)) return null;
  return { reading: d.reading, failed: d.failed, toReview: d.toReview };
}

/** The words in the pill, or null when it should be hidden. */
export function pillText(c: StatusCounts | null): { reading: string | null; failed: string | null } | null {
  if (!c || (c.reading === 0 && c.failed === 0)) return null;
  return {
    reading: c.reading > 0 ? `${c.reading} being read` : null,
    failed: c.failed > 0 ? `${c.failed} did not work` : null,
  };
}
