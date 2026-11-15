import { clientIp } from "./rate-limit";

const MAX_SHOWN = 300;

export type ConnectionReport = {
  forwardedFor: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  host: string | null;
  hops: number;
  signInIp: string;
  appOrigin: "not_set" | "matches" | "differs";
  /** The public host this visit used, for the "differs" message. */
  visitHost: string | null;
};

function shown(headers: Headers, name: string): string | null {
  const v = headers.get(name)?.trim();
  if (!v) return null;
  return v.length > MAX_SHOWN ? `${v.slice(0, MAX_SHOWN)}...` : v;
}

/**
 * What the app sees about this visit, for the owner's connection check.
 * Pure, for tests. Values are shown as text only, never as markup.
 */
export function connectionReport(headers: Headers, settings: { hops: number; appOrigin?: string }): ConnectionReport {
  const visitHost = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim().toLowerCase() || null;
  const visitProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() || null;
  let appOrigin: ConnectionReport["appOrigin"] = "not_set";
  if (settings.appOrigin) {
    const want = new URL(settings.appOrigin);
    const sameHost = visitHost !== null && want.host.toLowerCase() === visitHost;
    const sameProto = visitProto === null || `${visitProto}:` === want.protocol;
    appOrigin = sameHost && sameProto ? "matches" : "differs";
  }
  return {
    forwardedFor: shown(headers, "x-forwarded-for"),
    forwardedHost: shown(headers, "x-forwarded-host"),
    forwardedProto: shown(headers, "x-forwarded-proto"),
    host: shown(headers, "host"),
    hops: settings.hops,
    signInIp: clientIp(headers, settings.hops),
    appOrigin,
    visitHost: visitHost ? visitHost.slice(0, MAX_SHOWN) : null,
  };
}
