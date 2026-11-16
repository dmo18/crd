import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { itemLabel } from "@/lib/audit/subjects";
import { guardApi } from "@/lib/auth/guard";
import { startPhotoArchiver } from "@/lib/images/archive";
import { MAX_UPLOAD_BYTES } from "@/lib/images/store";
import { addPhoto, replacePhoto } from "@/lib/items/photos";
import { scanQueueBusy } from "@/lib/scans/process";
import { revalidatePath } from "next/cache";

const fieldsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("add"), role: z.enum(["front", "back"]) }),
  z.object({ mode: z.literal("replace"), imageId: z.coerce.number().int().positive() }),
]);

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** Add a front or back photo, or replace one. A form with `mode`, `role` or `imageId`, and the file named `photo`. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { id: rawId } = await ctx.params;
  if (!/^\d{1,9}$/.test(rawId)) return bad("That item was not found.", 404);
  const itemId = Number(rawId);

  // One photo plus a little for the form's own text.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
    return bad("That photo is too large. The limit is 15 MB.", 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("The photo did not arrive. Try again.", 408);
  }
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const fields = fieldsSchema.safeParse({ mode: text("mode"), role: text("role"), imageId: text("imageId") });
  if (!fields.success) return bad("That request was not understood.");
  const file = form.get("photo");
  if (!(file instanceof File)) return bad("Choose a photo first.");
  if (file.size > MAX_UPLOAD_BYTES) return bad("That photo is too large. The limit is 15 MB.", 413);

  const data = Buffer.from(await file.arrayBuffer());
  const label = itemLabel(itemId);
  const result = fields.data.mode === "add"
    ? await addPhoto({ itemId, role: fields.data.role, data })
    : await replacePhoto({ itemId, imageId: fields.data.imageId, data });
  if (!result.ok) return bad(result.error, 422);

  await auditThisRequest("photo_added", "ok", fields.data.mode === "add" ? `${label}, ${fields.data.role}` : `${label}, replaced a photo`);
  revalidatePath(`/items/${itemId}`);
  revalidatePath(`/items/${itemId}/photo/${result.imageId}`);
  revalidatePath("/items");
  void startPhotoArchiver({ busy: scanQueueBusy });
  return Response.json({ ok: true, imageId: result.imageId });
}
