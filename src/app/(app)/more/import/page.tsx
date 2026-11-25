import { ImportFlow } from "@/components/import/ImportFlow";
import { PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "Import from a spreadsheet" };

export default async function ImportPage() {
  await requireOwner();
  return (
    <>
      <PageHeader title="Import from a spreadsheet" subtitle="Bring in cards from a CSV file. Nothing is saved until you check the rows and say yes." />
      <ImportFlow />
    </>
  );
}
