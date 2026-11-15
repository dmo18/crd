import { z } from "zod";
import { guardApi } from "@/lib/auth/guard";
import { enqueueScan, queueOrder, retryScan } from "@/lib/scans/process";
import { getScanView } from "@/lib/scans/view";

const idSchema = z.coerce.number().int().positive();

/** Runs a failed scan again with the photos it already has. Nothing is uploaded again. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return Response.json({ error: "Scan not found." }, { status: 404 });
  const result = retryScan(id.data);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  enqueueScan(id.data);
  return Response.json(getScanView(id.data, undefined, queueOrder()), { status: 202, headers: { "Cache-Control": "no-store" } });
}
