import { Card, LinkButton, PageHeader } from "@/components/ui";

/**
 * Shown inside the app (with the tab bar) when a page is not there, such as
 * an item that was removed for good or a mistyped address.
 */
export default function NotFound() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Not found" />
      <Card className="flex flex-col gap-3">
        <p>This card or page is not here. It may have been removed for good, or the address is wrong.</p>
        <p className="text-sm text-muted">Items you deleted in the last 30 days are still in Recently deleted.</p>
        <LinkButton href="/">Back to your cards</LinkButton>
        <LinkButton href="/manage/deleted" variant="secondary">Recently deleted</LinkButton>
      </Card>
    </div>
  );
}
