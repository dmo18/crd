import { headers } from "next/headers";
import { Card, Notice } from "@/components/ui";
import { connectionReport } from "@/lib/auth/connection";
import { env } from "@/lib/env";

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="font-mono text-sm break-all">{value ?? "None"}</dd>
    </div>
  );
}

/**
 * Owner only (the More page calls requireOwner first). Shows what the app
 * sees about this visit, to set TRUST_PROXY_HOPS and APP_ORIGIN correctly.
 * All values are plain text; React escapes them.
 */
export async function ConnectionCheck() {
  const e = env();
  const r = connectionReport(await headers(), { hops: e.TRUST_PROXY_HOPS, appOrigin: e.APP_ORIGIN });
  const origin =
    r.appOrigin === "not_set"
      ? "Not set"
      : r.appOrigin === "matches"
        ? `Set to ${e.APP_ORIGIN} and matches this visit`
        : `Set to ${e.APP_ORIGIN} but this visit came to ${r.visitHost ?? "an unknown address"}`;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Connection check</h2>
      <p className="text-sm text-muted">What this server sees about your visit. Useful when setting up hosting.</p>
      <dl className="flex flex-col gap-2">
        <Row label="IP used for sign-in limits" value={r.signInIp} />
        <Row label="Trusted proxy hops (TRUST_PROXY_HOPS)" value={String(r.hops)} />
        <Row label="Forwarded for chain (X-Forwarded-For)" value={r.forwardedFor} />
        <Row label="Forwarded host (X-Forwarded-Host)" value={r.forwardedHost} />
        <Row label="Forwarded protocol (X-Forwarded-Proto)" value={r.forwardedProto} />
        <Row label="Host header" value={r.host} />
        <Row label="Public address (APP_ORIGIN)" value={origin} />
      </dl>
      <Notice tone={r.appOrigin === "differs" || r.signInIp === "unknown" ? "warn" : "neutral"}>
        If &apos;IP used for sign-in limits&apos; is not your phone&apos;s internet address, change TRUST_PROXY_HOPS.
      </Notice>
    </Card>
  );
}
