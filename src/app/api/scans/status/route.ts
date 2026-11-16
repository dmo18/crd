import { z } from "zod";
import { guardApi } from "@/lib/auth/guard";
import { queueOrder, recoverScans } from "@/lib/scans/process";
import { scanStatusCounts, scanViews } from "@/lib/scans/view";

/** At most this many scan ids in one ask (the scan screen holds at most 100). */
export const MAX_STATUS_IDS = 100;

/** `?ids=1,2,3`: 1 to 100 whole numbers above 0, repeats removed. */
const idsSchema = z
  .string()
  .max(MAX_STATUS_IDS * 12)
  .transform((s) => s.split(","))
  .pipe(z.array(z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647))).min(1).max(MAX_STATUS_IDS))
  .transform((ids) => [...new Set(ids)]);

/**
 * Counts for the "being read" pill: { reading, failed, toReview }.
 * With `?ids=` it also returns `scans`: the progress of those scans, so the
 * scan screen needs one ask for all its photos instead of one per photo.
 */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const raw = new URL(request.url).searchParams.get("ids");
  let ids: number[] | null = null;
  if (raw !== null) {
    const parsed = idsSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: "Bad list of scans." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    ids = parsed.data;
  }
  recoverScans();
  const counts = scanStatusCounts();
  const body = ids ? { ...counts, scans: scanViews(ids, undefined, queueOrder()) } : counts;
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
