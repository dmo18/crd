import { ChangePassword } from "@/components/more/ChangePassword";
import { ConnectionCheck } from "@/components/more/ConnectionCheck";
import { SignOutOthers } from "@/components/more/SignOutOthers";
import { SignOutButton } from "@/components/nav/SignOutButton";
import { Card, LinkButton, Notice, PageHeader } from "@/components/ui";
import { recognitionMode } from "@/lib/env";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "More" };

export default async function MorePage() {
  await requireOwner();
  const mode = recognitionMode();
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
        <h2 className="text-lg font-semibold">Card reading</h2>
        <Notice tone={mode === "sample" ? "warn" : "accent"}>
          {mode === "free"
            ? "Cards are read on this server with free text recognition, and players are checked on Wikidata, a free public database. No keys or accounts needed. Blurry or glossy photos may need a quick fix in Review."
            : mode === "sample"
              ? "Sample mode: scans return made-up example cards."
              : "Optional paid AI reading is on."}
        </Notice>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">About values</h2>
        <p className="text-sm text-muted">
          Values come from your own entries, using sold listings. AI estimates appear only if paid AI is turned on.
          They are a guide, not an appraisal. Check recent sold listings before you sell or insure anything.
          If you enter your own value for an item, your value always wins.
        </p>
      </Card>

      <ChangePassword />

      <SignOutOthers />

      <ConnectionCheck />

      <SignOutButton />
    </div>
  );
}
