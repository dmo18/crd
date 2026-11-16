import { guardApi } from "@/lib/auth/guard";
import { recoverScans } from "@/lib/scans/process";
import { scanStatusCounts } from "@/lib/scans/view";

/** Counts for the "being read" pill: { reading, failed, toReview }. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  recoverScans();
  return Response.json(scanStatusCounts(), { headers: { "Cache-Control": "no-store" } });
}
