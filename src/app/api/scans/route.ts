import { z } from "zod";
import { SCAN_MODES } from "@/db/schema";
import { guardApi } from "@/lib/auth/guard";
import { errorKind, log, requestIdFrom } from "@/lib/log";
import { MAX_PHOTOS_PER_SCAN, MAX_UPLOAD_BYTES } from "@/lib/images/store";
import { createScan, ScanInputError, type ScanPhotoInput, type ScanPhotoRole } from "@/lib/scans/create";
import { enqueueScan, queueOrder, recoverScans } from "@/lib/scans/process";
import { recentScans } from "@/lib/scans/view";

const fieldsSchema = z.object({
  mode: z.enum(SCAN_MODES),
  hint: z.string().max(200).optional(),
  locationId: z.coerce.number().int().positive().optional(),
  clientKey: z.string().uuid().optional(),
});

const ROLES: ScanPhotoRole[] = ["front", "back", "source"];
// The whole request, all photos together. Must stay in step with
// proxyClientMaxBodySize in next.config.ts. Phones shrink photos before
// sending, so twelve photos normally total well under this.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** Start a scan: a form with mode, optional hint and locationId, and photo files named front, back or source. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return bad("Those photos are too large to send together.", 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("The photos did not arrive. Try again.");
  }

  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const fields = fieldsSchema.safeParse({ mode: text("mode"), hint: text("hint"), locationId: text("locationId"), clientKey: text("clientKey") });
  if (!fields.success) return bad("That scan request was not understood.");

  const photos: ScanPhotoInput[] = [];
  for (const role of ROLES) {
    for (const entry of form.getAll(role)) {
      if (!(entry instanceof File)) continue;
      if (photos.length >= MAX_PHOTOS_PER_SCAN) return bad(`That is too many photos. The limit is ${MAX_PHOTOS_PER_SCAN}.`);
      if (entry.size > MAX_UPLOAD_BYTES) return bad("One of those photos is too large. The limit is 15 MB each.", 413);
      photos.push({ role, data: Buffer.from(await entry.arrayBuffer()) });
    }
  }

  try {
    const { scanId, duplicate } = await createScan({ ...fields.data, photos });
    // A repeat of an upload we already have changes nothing and is not queued twice.
    if (duplicate) return Response.json({ scanId }, { status: 200 });
    enqueueScan(scanId);
    return Response.json({ scanId }, { status: 201 });
  } catch (err) {
    if (err instanceof ScanInputError) return bad(err.userMessage);
    log.error("scan_create_failed", { requestId: requestIdFrom(request.headers), error: errorKind(err) });
    return bad("Could not start the scan. Try again.", 500);
  }
}

/** Recent scans with their items, newest first. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  recoverScans();
  return Response.json({ scans: recentScans(20, undefined, queueOrder()) }, { headers: { "Cache-Control": "no-store" } });
}
