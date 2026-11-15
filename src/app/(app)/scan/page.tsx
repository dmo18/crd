import { asc } from "drizzle-orm";
import { ScanFlow } from "@/components/items/ScanFlow";
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
      <PageHeader title="Scan" subtitle="Photograph what you have and the AI will identify and value it." />
      <ScanFlow rules={PHOTO_RULES} locations={options} />
    </>
  );
}
