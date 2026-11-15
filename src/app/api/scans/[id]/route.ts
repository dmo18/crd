import { z } from "zod";
import { guardApi } from "@/lib/auth/guard";
import { queueOrder, recoverScans } from "@/lib/scans/process";
import { getScanView } from "@/lib/scans/view";

const idSchema = z.coerce.number().int().positive();

/** One scan's progress and the items it produced. The browser polls this. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return Response.json({ error: "Scan not found." }, { status: 404 });
  recoverScans();
  const view = getScanView(id.data, undefined, queueOrder());
  if (!view) return Response.json({ error: "Scan not found." }, { status: 404 });
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
