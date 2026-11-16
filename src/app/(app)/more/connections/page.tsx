import { ConnectionCard } from "@/components/connections/ConnectionCard";
import { LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { requireOwner } from "@/lib/auth/guard";
import { SOURCES } from "@/lib/outside/sources";
import { connectionsView } from "@/lib/outside/view";

export const metadata = { title: "Connections" };

/** Outside sources the app uses: state, switch, Test, stored answers, keys and usage. Owner only. */
export default async function ConnectionsPage() {
  await requireOwner();
  const views = connectionsView(getDb());
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Connections"
        subtitle="Free outside sources the app asks for card facts. Each call is counted and kept within limits."
        action={<LinkButton href="/more" variant="ghost">Back</LinkButton>}
      />
      {views.map((v) => (
        <ConnectionCard key={v.id} view={v} keyHint={SOURCES[v.id].key?.hint ?? ""} />
      ))}
    </div>
  );
}
