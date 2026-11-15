import { clientIp } from "./rate-limit";

const MAX_SHOWN = 300;

export type ConnectionReport = {
  forwardedFor: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  host: string | null;
  hops: number;
  /** CLIENT_IP_HEADER as configured (lowercase), or null when off. */
  clientIpHeader: string | null;
  /** What that header held on this visit, or null when off or missing. */
  clientIpHeaderValue: string | null;
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
export function connectionReport(headers: Headers, settings: { hops: number; appOrigin?: string; clientIpHeader?: string }): ConnectionReport {
  const visitHost = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim().toLowerCase() || null;
  const visitProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() || null;
  let appOrigin: ConnectionReport["appOrigin"] = "not_set";
  if (settings.appOrigin) {
    const want = new URL(settings.appOrigin);
    const sameHost = visitHost !== null && want.host.toLowerCase() === visitHost;
    // Behind Cloudflare and Traefik the last hop is plain http even though
    // visitors use https, so only https visits to an http address count as
    // a mismatch.
    const sameProto = visitProto === null || `${visitProto}:` === want.protocol || (visitProto === "http" && want.protocol === "https:");
    appOrigin = sameHost && sameProto ? "matches" : "differs";
  }
  return {
    forwardedFor: shown(headers, "x-forwarded-for"),
    forwardedHost: shown(headers, "x-forwarded-host"),
    forwardedProto: shown(headers, "x-forwarded-proto"),
    host: shown(headers, "host"),
    hops: settings.hops,
    clientIpHeader: settings.clientIpHeader ? settings.clientIpHeader.toLowerCase() : null,
    clientIpHeaderValue: settings.clientIpHeader ? shown(headers, settings.clientIpHeader.toLowerCase()) : null,
    signInIp: clientIp(headers, settings.hops, settings.clientIpHeader),
    appOrigin,
    visitHost: visitHost ? visitHost.slice(0, MAX_SHOWN) : null,
  };
}
