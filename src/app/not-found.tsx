import { Card, LinkButton, PageHeader } from "@/components/ui";

export const metadata = { title: "Not found" };

/**
 * Shown for an address the app does not have ("/nope"). Only a visitor who
 * is signed in gets here: the proxy sends everyone else to the sign-in page
 * first. It shows nothing from the collection, only the way back.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-4">
      <PageHeader title="Not found" />
      <Card className="flex flex-col gap-3">
        <p>There is no page at this address. It may be mistyped, or the link is old.</p>
        <LinkButton href="/">Back to your cards</LinkButton>
      </Card>
    </main>
  );
}
