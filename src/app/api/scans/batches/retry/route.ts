import { z } from "zod";
import { guardApi } from "@/lib/auth/guard";
import { batchKeySchema, batchReports, retryBatch } from "@/lib/scans/batch";
import { enqueueScan } from "@/lib/scans/process";

const bodySchema = z.strictObject({ batchKey: batchKeySchema });

/**
 * "Try the failed ones again" for one upload: only its failed scans go back
 * in the queue, with the photos they already have. Read cards are never read again.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "That request was not understood." }, { status: 400 });
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return Response.json({ error: "That request was not understood." }, { status: 400 });
  const result = retryBatch(body.data.batchKey);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  for (const id of result.queued) enqueueScan(id);
  return Response.json(
    { queued: result.queued.length, gone: result.gone, batch: batchReports().find((b) => b.key === body.data.batchKey) ?? null },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
