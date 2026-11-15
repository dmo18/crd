import { cookies, headers } from "next/headers";
import type { AuditEvent, AuditOutcome } from "@/db/schema";
import { clientIp } from "@/lib/auth/rate-limit";
import { currentSessionVersion } from "@/lib/auth/password";
import { DEVICE_COOKIE, readDevice } from "@/lib/auth/seal";
import { env } from "@/lib/env";
import { requestIdFrom } from "@/lib/log";
import { recordAudit, type AuditWriteOptions } from "./store";

export type RequestContext = { ip: string; deviceId: string | null; requestId?: string };

/** The visitor's address (as used for sign-in limits) and trusted-device id, for the activity log. */
export async function requestContext(): Promise<RequestContext> {
  const e = env();
  const h = await headers();
  const ip = clientIp(h, e.TRUST_PROXY_HOPS, e.CLIENT_IP_HEADER);
  let deviceId: string | null = null;
  try {
    deviceId = await readDevice((await cookies()).get(DEVICE_COOKIE)?.value, e.SESSION_SECRET, currentSessionVersion());
  } catch {
    deviceId = null;
  }
  return { ip, deviceId, requestId: requestIdFrom(h) };
}

/** Records an event for the current request. Never throws. */
export async function auditThisRequest(
  event: AuditEvent, outcome: AuditOutcome, detail?: string | null, opts?: AuditWriteOptions,
): Promise<void> {
  try {
    const ctx = await requestContext();
    recordAudit({ event, outcome, ip: ctx.ip, deviceId: ctx.deviceId, detail }, opts);
  } catch {
    // The activity log must never break the action itself.
  }
}
