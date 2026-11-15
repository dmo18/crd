import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { items, locations } from "@/db/schema";
import { guardApi } from "@/lib/auth/guard";
import { itemsToCsv } from "@/lib/export/csv";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = await guardApi(request);
  if (blocked) return blocked;
  const db = getDb();
  const rows = db.select().from(items).orderBy(asc(items.id)).all();
  const names = new Map(db.select({ id: locations.id, name: locations.name }).from(locations).all().map((l) => [l.id, l.name]));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(itemsToCsv(rows, names), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="card-vault-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
