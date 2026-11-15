/**
 * Runs once when the server starts. Only warns: a setting that weakens
 * sign-in limits must never stop the app from starting.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { env } = await import("@/lib/env");
    const { addressAlwaysUnknown, UNKNOWN_ADDRESS_WARNING } = await import("@/lib/auth/connection");
    const e = env();
    if (addressAlwaysUnknown({ nodeEnv: e.NODE_ENV, hops: e.TRUST_PROXY_HOPS, clientIpHeader: e.CLIENT_IP_HEADER })) {
      console.warn(`WARNING: ${UNKNOWN_ADDRESS_WARNING}`);
    }
  } catch {
    // Bad settings are reported clearly by the first request that needs them.
  }
}
