import { Alerts } from "@/components/more/Alerts";
import { ChangePassword } from "@/components/more/ChangePassword";
import { ConnectionCheck } from "@/components/more/ConnectionCheck";
import { SignOutOthers } from "@/components/more/SignOutOthers";
import { SignOutButton } from "@/components/nav/SignOutButton";
import { Card, LinkButton, Notice, PageHeader } from "@/components/ui";
import { alertChannels, recognitionMode } from "@/lib/env";
import { formatBytes, storageSummary } from "@/lib/images/archive";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "More" };

export default async function MorePage() {
  await requireOwner();
  const mode = recognitionMode();
  const channels = alertChannels().map((c) => (c === "telegram" ? "Telegram" : "Discord"));
  const storage = storageSummary();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="More" />

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Locations</h2>
        <p className="text-sm text-muted">Boxes, binders and shelves where your cards are kept.</p>
        <LinkButton href="/locations" variant="secondary">Manage locations</LinkButton>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Scan activity</h2>
        <p className="text-sm text-muted">What was read, what is waiting and what did not work.</p>
        <LinkButton href="/scans" variant="secondary">See scan activity</LinkButton>
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
        <h2 className="text-lg font-semibold">Photo storage</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Photos</dt>
          <dd className="text-right font-semibold">{storage.photos.toLocaleString("en-US")}</dd>
          <dt className="text-muted">Space used</dt>
          <dd className="text-right font-semibold">{formatBytes(storage.totalBytes)}</dd>
          <dt className="text-muted">Average per card</dt>
          <dd className="text-right font-semibold">{storage.perItemBytes == null ? "No cards yet" : formatBytes(storage.perItemBytes)}</dd>
          <dt className="text-muted">Waiting to be made smaller</dt>
          <dd className="text-right font-semibold">{storage.waiting.toLocaleString("en-US")}</dd>
        </dl>
        <p className="text-sm text-muted">
          Photos are kept in a small, sharp format (AVIF). New photos are made smaller right after they are read, and
          older photos a few at a time in the background. Photos of a failed scan stay full size for 7 days, so you can try again.
        </p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">About values</h2>
        <p className="text-sm text-muted">
          Values come from your own entries, using sold listings. AI estimates appear only if paid AI is turned on.
          They are a guide, not an appraisal. Check recent sold listings before you sell or insure anything.
          If you enter your own value for an item, your value always wins.
        </p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="text-sm text-muted">Sign-ins, wrong passwords and deletions from the last year.</p>
        <LinkButton href="/more/activity" variant="secondary">See activity</LinkButton>
      </Card>

      <Alerts channels={channels} />

      <ChangePassword />

      <SignOutOthers />

      <ConnectionCheck />

      <SignOutButton />
    </div>
  );
}
