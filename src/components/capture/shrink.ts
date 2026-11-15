/**
 * Shrinks a photo in the browser before upload: long edge at most maxEdge,
 * JPEG, orientation applied. Falls back to the original file on any problem.
 * Browser only.
 */
export async function shrinkPhoto(file: File, maxEdge = 2000, quality = 0.85): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return file;
      const isJpeg = file.type === "image/jpeg";
      if (isJpeg && blob.size >= file.size) return file;
      const name = file.name.replace(/\.[^.]*$/, "") || "photo";
      return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

/** True when the browser can decode the file as an image. Browser only. */
export async function canDecode(file: File): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(file);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}
