import { getDb } from "@/db";
import { locations } from "@/db/schema";
import { auditThisRequest } from "@/lib/audit/request";
import { guardApi } from "@/lib/auth/guard";
import { itemsToCsv } from "@/lib/export/csv";
import { exportPick } from "@/lib/export/select";

export const dynamic = "force-dynamic";

/** The collection as CSV. With `ids` or inventory filters in the link, only those items (see exportPick). */
export async function GET(request: Request) {
  const blocked = await guardApi(request);
  if (blocked) return blocked;
  const db = getDb();
  const pick = exportPick(new URL(request.url).searchParams, db);
  if ("error" in pick) return Response.json({ error: pick.error }, { status: 400 });
  const rows = pick.rows;
  const names = new Map(db.select({ id: locations.id, name: locations.name }).from(locations).all().map((l) => [l.id, l.name]));
  const day = new Date().toISOString().slice(0, 10);
  const scope = pick.what === "all" ? "" : pick.what === "filtered" ? ", filtered" : ", selected";
  await auditThisRequest("export_csv", "ok", `${rows.length} ${rows.length === 1 ? "item" : "items"}${scope}`);
  return new Response(itemsToCsv(rows, names), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="card-vault-${day}${pick.what === "all" ? "" : `-${pick.what}`}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
