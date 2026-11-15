"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * A time shown in the phone's own time zone. The server does not know that
 * zone, so it first renders the date in UTC and the browser fills in the rest.
 */
export function LocalTime({ ms }: { ms: number }) {
  const local = useSyncExternalStore(
    subscribe,
    () => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    () => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC",
  );
  return <time dateTime={new Date(ms).toISOString()}>{local}</time>;
}
