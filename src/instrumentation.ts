/**
 * Runs once when the server starts. Only warns: a setting that weakens
 * sign-in limits must never stop the app from starting.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { alertChannels, env } = await import("@/lib/env");
    const { addressAlwaysUnknown } = await import("@/lib/auth/connection");
    const { log } = await import("@/lib/log");
    const e = env();
    if (addressAlwaysUnknown({ nodeEnv: e.NODE_ENV, hops: e.TRUST_PROXY_HOPS, clientIpHeader: e.CLIENT_IP_HEADER })) {
      // Full explanation: More, Connection check.
      log.warn("sign_in_address_unknown", { message: "Sign-in limits cannot tell visitors apart. Set CLIENT_IP_HEADER or TRUST_PROXY_HOPS." });
    }
    log.info("server_started", { alerts: alertChannels(e).join(",") || "off" });
    // One pass at every start: items without a value get the built-in guide price,
    // guide prices follow table changes. Idempotent; never touches the owner's values.
    try {
      const { fillGuidePrices } = await import("@/lib/valuation/guide/apply");
      const changed = fillGuidePrices();
      if (changed > 0) log.info("guide_prices_filled", { changed });
    } catch (err) {
      const { errorKind } = await import("@/lib/log");
      log.warn("guide_fill_failed", { error: errorKind(err) });
    }
  } catch {
    // Bad settings are reported clearly by the first request that needs them.
  }
}
