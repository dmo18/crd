import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditThisRequest } from "@/lib/audit/request";
import { guardApi } from "@/lib/auth/guard";
import { CSV_MESSAGES, MAX_CSV_BYTES, utf8Bytes } from "@/lib/import/csv";
import { applyImport, parseOptions, previewImport } from "@/lib/import/plan";
import { errorKind, log, requestIdFrom } from "@/lib/log";

export const dynamic = "force-dynamic";

/** The file plus the few choices that go with it. The file is read in memory only, never written to disk. */
const MAX_BODY_BYTES = MAX_CSV_BYTES + 64 * 1024;

const countsSchema = z.strictObject({
  rows: z.number().int().min(0), added: z.number().int().min(0), updated: z.number().int().min(0),
  unchanged: z.number().int().min(0), duplicates: z.number().int().min(0), problems: z.number().int().min(0),
});
const requestSchema = z.strictObject({
  step: z.enum(["check", "apply"]),
  mapping: z.array(z.string().max(40)).min(1).max(200),
  options: z.unknown(),
  skipProblems: z.boolean().optional(),
  expected: countsSchema.optional(),
});

const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Spreadsheet import, step 3 (check) and step 4 (apply). A form with `text`
 * (the CSV file's text) and `request` (JSON: step, column choices, options).
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;

  const declared = request.headers.get("content-length");
  if (declared === null) return bad("The file did not arrive. Try again.", 411);
  if (Number(declared) > MAX_BODY_BYTES) return bad(CSV_MESSAGES.tooBig, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("The file did not arrive. Try again.", 408);
  }
  const text = form.get("text");
  const rawRequest = form.get("request");
  if (typeof text !== "string" || typeof rawRequest !== "string" || rawRequest.length > 20_000) return bad("That request was not understood.");
  if (utf8Bytes(text) > MAX_CSV_BYTES) return bad(CSV_MESSAGES.tooBig, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawRequest);
  } catch {
    return bad("That request was not understood.");
  }
  const req = requestSchema.safeParse(parsedJson);
  if (!req.success) return bad("That request was not understood.");
  const options = parseOptions(req.data.options);
  if ("error" in options) return bad(options.error);

  try {
    if (req.data.step === "check") {
      const preview = previewImport(text, req.data.mapping, options);
      if ("error" in preview) return bad(preview.error);
      return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
    }
    const result = applyImport(text, req.data.mapping, options, { skipProblems: req.data.skipProblems === true, expected: req.data.expected });
    if ("error" in result) return bad(result.error, 409);
    await auditThisRequest("bulk_edit", "ok", result.summary);
    for (const p of ["/", "/items", "/review", "/manage", "/manage/deleted", "/locations"]) revalidatePath(p);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error("import_failed", { requestId: requestIdFrom(request.headers), step: req.data.step, error: errorKind(err) });
    return bad("Something went wrong. Nothing was saved. Try again.", 500);
  }
}
