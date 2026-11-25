import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { DeleteFailedScans } from "@/components/items/DeleteFailedScans";
import { ScanActivity } from "@/components/items/ScanActivity";
import { EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { scans } from "@/db/schema";
import { requireOwner } from "@/lib/auth/guard";
import { queueOrder, recoverScans } from "@/lib/scans/process";
import { recentScans, scanPhotoThumbs } from "@/lib/scans/view";
import { BatchReportCard } from "@/components/items/BatchReportCard";
import { batchReports, catalogLimitNow, catalogLimitText, catalogSkippedText } from "@/lib/scans/batch";

export const metadata = { title: "Scan activity" };

const noticeSchema = z.object({ cleared: z.coerce.number().int().min(0).max(1_000_000).optional().catch(undefined) });

export default async function ScansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const { cleared } = noticeSchema.parse({ cleared: one(raw.cleared) });
  recoverScans();
  const db = getDb();
  const list = recentScans(50, db, queueOrder());
  const thumbs = scanPhotoThumbs(list.map((s) => s.id), db);
  const photos: Record<number, string> = {};
  for (const [id, file] of thumbs) photos[id] = file;
  const failedTotal = db.select({ n: count() }).from(scans).where(eq(scans.status, "failed")).get()?.n ?? 0;
  const batches = batchReports(db);
  // Said plainly while a limit holds the catalog back and cards are still waiting.
  const limit = batches.some((b) => b.waiting > 0) ? catalogLimitNow(db) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Scan activity" subtitle="The last 50 scans, newest first" />
      {cleared !== undefined ? (
        <Notice tone="accent">{cleared === 1 ? "Deleted 1 failed scan." : `Deleted ${cleared} failed scans.`}</Notice>
      ) : null}
      {limit ? <Notice tone="warn">{catalogLimitText(limit)}</Notice> : null}
      {batches.map((b) => <BatchReportCard key={b.key} report={b} skippedLine={catalogSkippedText(b.catalogSkipped)} />)}
      {failedTotal > 0 ? <div className="rounded-2xl border border-border bg-surface p-3"><DeleteFailedScans count={failedTotal} back="scans" /></div> : null}
      {list.length === 0 ? (
        <EmptyState title="No scans yet" body="Photos you save on the Scan screen show up here." action={<LinkButton href="/scan">Scan a card</LinkButton>} />
      ) : (
        <ScanActivity scans={list} photos={photos} />
      )}
    </div>
  );
}
