import { guardApi } from "@/lib/auth/guard";
import { batchReports, catalogLimitNow } from "@/lib/scans/batch";
import { recoverScans } from "@/lib/scans/process";

/** The latest "Many photos, one card each" uploads: how many are read, waiting and failed. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  recoverScans();
  return Response.json({ batches: batchReports(), catalogLimit: catalogLimitNow() }, { headers: { "Cache-Control": "no-store" } });
}
