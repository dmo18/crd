import { SignOutButton } from "@/components/nav/SignOutButton";
import { Card, LinkButton, Notice, PageHeader } from "@/components/ui";
import { recognitionMode } from "@/lib/env";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "More" };

export default async function MorePage() {
  await requireOwner();
  const real = recognitionMode() === "anthropic";
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="More" />

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Locations</h2>
        <p className="text-sm text-muted">Boxes, binders and shelves where your cards are kept.</p>
        <LinkButton href="/locations" variant="secondary">Manage locations</LinkButton>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Export</h2>
        <a
          href="/api/export" download
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-base font-semibold text-text"
        >
          Download spreadsheet (CSV)
        </a>
        <p className="text-sm text-muted">Opens in Excel, Numbers or Google Sheets. Good for insurance records.</p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">AI recognition</h2>
        <Notice tone={real ? "accent" : "warn"}>
          {real
            ? "Real AI recognition is on."
            : "Sample mode: scans return made-up example cards. Add an AI key in the server settings to read real cards."}
        </Notice>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">About values</h2>
        <p className="text-sm text-muted">
          Values are AI estimates, not appraisals. Check recent sold listings before you sell or insure anything.
          If you enter your own value for an item, your value always wins.
        </p>
      </Card>

      <SignOutButton />
    </div>
  );
}
