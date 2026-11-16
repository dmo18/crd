import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PhotoTools } from "@/components/items/PhotoTools";
import { getDb } from "@/db";
import { images, items } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "Photo" };

const ROLE_NAMES = { front: "Front", back: "Back", crop: "Front", source: "Original photo" } as const;

export default async function PhotoPage({ params }: { params: Promise<{ id: string; imageId: string }> }) {
  await requireOwner();
  const { id: rawId, imageId: rawImage } = await params;
  if (!/^\d{1,9}$/.test(rawId) || !/^\d{1,9}$/.test(rawImage)) notFound();
  const db = getDb();
  const row = db.select({ image: images, title: items.title }).from(images).innerJoin(items, eq(images.itemId, items.id))
    .where(and(eq(images.id, Number(rawImage)), eq(images.itemId, Number(rawId)), isNull(items.deletedAt))).get();
  if (!row) notFound();
  const { image, title } = row;
  return (
    <div className="flex flex-col gap-4">
      <Link href={`/items/${rawId}`} className="inline-flex min-h-11 items-center text-base font-semibold text-accent">Back to the card</Link>
      <h1 className="text-2xl font-bold text-balance break-words">{ROLE_NAMES[image.role]} photo</h1>
      <p className="text-sm text-muted break-words">{title}</p>
      <PhotoTools
        itemId={Number(rawId)}
        imageId={image.id}
        src={`/api/images/${image.file}`}
        alt={`${ROLE_NAMES[image.role]} photo of ${title}`}
        hasOriginal={image.originalFile != null}
        canReplace={image.role !== "source"}
      />
    </div>
  );
}
