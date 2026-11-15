import { guardApi } from "@/lib/auth/guard";
import { ImageError, isValidImageName, readPhoto } from "@/lib/images/store";

export async function GET(request: Request, ctx: { params: Promise<{ file: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;

  const { file } = await ctx.params;
  if (!isValidImageName(file)) return Response.json({ error: "Photo not found." }, { status: 404 });
  try {
    // AVIF archive, an older JPEG, or the working copy (JPEG) of a photo not converted yet.
    const { data, contentType } = await readPhoto(file);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ImageError) return Response.json({ error: "Photo not found." }, { status: 404 });
    return Response.json({ error: "Could not load the photo." }, { status: 500 });
  }
}
