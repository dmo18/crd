import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Public on purpose (the watchdog calls it). Never returns any detail. */
export async function GET() {
  const { ok } = checkHealth();
  return new Response(JSON.stringify({ ok }), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
