import { headers } from "next/headers";
import { Card, Notice } from "@/components/ui";
import { addressAlwaysUnknown, connectionReport } from "@/lib/auth/connection";
import { env } from "@/lib/env";

/**
 * Owner only (the More page calls requireOwner first). Shows, in plain words,
 * the internet address the server sees for this visit and whether the sign-in
 * limits can tell visitors apart. The setting names are for whoever runs the
 * server and stay out of this screen (see .env.example and docs).
 * All values are plain text; React escapes them.
 */
export async function ConnectionCheck() {
  const e = env();
  const r = connectionReport(await headers(), { hops: e.TRUST_PROXY_HOPS, appOrigin: e.APP_ORIGIN, clientIpHeader: e.CLIENT_IP_HEADER });
  const blind = addressAlwaysUnknown({ nodeEnv: e.NODE_ENV, hops: e.TRUST_PROXY_HOPS, clientIpHeader: e.CLIENT_IP_HEADER }) || r.signInIp === "unknown";
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Connection check</h2>
      <p className="text-sm text-muted">The internet address the server sees for this phone or computer.</p>
      <p className="font-mono text-sm break-all">{blind ? "Not known" : r.signInIp}</p>
      {blind ? (
        <div role="alert">
          <Notice tone="warn">
            The server cannot tell visitors apart, so too many wrong passwords from anyone pause sign-in for new phones and computers. Ask whoever runs the server to fix the connection settings.
          </Notice>
        </div>
      ) : (
        <p className="text-sm text-muted">If this is not your internet address, ask whoever runs the server to check the connection settings.</p>
      )}
      {r.appOrigin === "differs" ? (
        <Notice tone="warn">This visit came to a different web address than the one the app was set up for. Sign-in may not work there.</Notice>
      ) : null}
    </Card>
  );
}
