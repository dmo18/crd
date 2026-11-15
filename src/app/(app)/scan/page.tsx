import { ScanFlow } from "@/components/items/ScanFlow";
import { PageHeader } from "@/components/ui";
import { PHOTO_RULES } from "@/lib/scans/create";

export const metadata = { title: "Scan" };

export default function ScanPage() {
  return (
    <>
      <PageHeader title="Scan" subtitle="Photograph what you have and the AI will identify and value it." />
      <ScanFlow rules={PHOTO_RULES} />
    </>
  );
}
