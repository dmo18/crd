import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { listLocations } from "@/lib/locations/locations";
import { AddLocationForm, DeleteLocationButton, EditLocationForm } from "./LocationForms";
import { requireOwner } from "@/lib/auth/guard";

export const metadata = { title: "Locations" };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export default async function LocationsPage() {
  await requireOwner();
  const list = listLocations();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Locations" subtitle="Where your cards physically live, so you can find them again." />

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Add a location</h2>
        <AddLocationForm />
      </Card>

      {list.length === 0 ? (
        <EmptyState
          title="No locations yet"
          body={'A location is a place where you keep cards, like "Box 1" or "Rookies binder". Add one above, then choose it when you scan or edit an item.'}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((l) => (
            <li key={l.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 text-lg font-semibold break-words">{l.name}</h2>
                  {l.kind ? <Badge>{l.kind}</Badge> : null}
                </div>
                <p className="text-sm text-muted">
                  {[plural(l.itemCount, "item", "items"), plural(l.unitCount, "card and product", "cards and products"), formatCents(l.totalValueCents)].join(" · ")}
                </p>
                {l.notes ? <p className="text-sm break-words">{l.notes}</p> : null}
                <LinkButton href={`/items?location=${l.id}`} variant="secondary">View items</LinkButton>
                <details className="rounded-xl border border-border px-3">
                  <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold">Edit</summary>
                  <div className="pb-3">
                    <EditLocationForm location={{ id: l.id, name: l.name, kind: l.kind, notes: l.notes }} />
                  </div>
                </details>
                <DeleteLocationButton id={l.id} name={l.name} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
