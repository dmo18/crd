import { asc } from "drizzle-orm";
import { ScanFlow } from "@/components/items/ScanFlow";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { locations } from "@/db/schema";
import { PHOTO_RULES } from "@/lib/scans/create";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "Scan" };

export default async function ScanPage() {
  await requireOwner();
  const options = getDb().select({ id: locations.id, name: locations.name }).from(locations).orderBy(asc(locations.name)).all();
  return (
    <>
      <PageHeader title="Scan" subtitle="Pick the photos and tap Save. Then scan the next one while the app reads." />
      <ScanFlow rules={PHOTO_RULES} locations={options} />
      <p className="pt-6 text-center text-sm text-muted">
        No photo?{" "}
        <Link href="/search" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Or search by words</Link>
        {" "}or{" "}
        <Link href="/items/new" className="inline-flex min-h-11 items-center font-semibold text-accent underline">add by hand</Link>.
      </p>
    </>
  );
}
