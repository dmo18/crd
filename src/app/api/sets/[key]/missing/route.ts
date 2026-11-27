import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { guardApi } from "@/lib/auth/guard";
import { SET_KEY_RE } from "@/lib/sets/identity";
import { missingCsv } from "@/lib/sets/missing";
import { setView } from "@/lib/sets/view";

export const dynamic = "force-dynamic";

const keySchema = z.string().max(170).regex(SET_KEY_RE);

/** A set's missing and wanted cards as CSV (the set page's download). */
export async function GET(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const blocked = await guardApi(request);
  if (blocked) return blocked;
  const key = keySchema.safeParse((await ctx.params).key);
  const view = key.success ? setView(key.data) : null;
  if (!key.success || !view) return Response.json({ error: "This set could not be found." }, { status: 404 });
  const missing = view.rows.filter((r) => !r.owned).length;
  await auditThisRequest("export_csv", "ok", `Missing list of ${view.label}, ${missing} ${missing === 1 ? "card" : "cards"}`.slice(0, 200));
  return new Response(missingCsv(view), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="missing-${key.data.replace(/_+/g, "-").replace(/-+$/, "")}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
