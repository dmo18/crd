import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/activity/LocalTime";
import { CopyMissing } from "@/components/sets/CopyMissing";
import { GetChecklist } from "@/components/sets/GetChecklist";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth/guard";
import { toggleWantAction } from "@/lib/sets/actions";
import { SET_KEY_RE } from "@/lib/sets/identity";
import { asFailure, MAY_BE_INCOMPLETE, NOT_IN_CATALOG, stoppedLine } from "@/lib/sets/messages";
import { missingText } from "@/lib/sets/missing";
import { CHECKLIST_KEEP_DAYS, setView, type SetRow } from "@/lib/sets/view";

export const metadata = { title: "Set" };
export const dynamic = "force-dynamic";

const SHOWS = ["all", "owned", "missing", "wanted"] as const;
type Show = (typeof SHOWS)[number];
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Row({ r, setKey, hasList }: { r: SetRow; setKey: string; hasList: boolean }) {
  const num = r.cardNumber ? `#${r.cardNumber}` : "#?";
  if (r.owned) {
    const first = r.items[0];
    const review = r.items.some((i) => i.inReview);
    return (
      <li>
        <Link href={`/items/${first.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2">
          <span className="min-w-0">
            <span className="block font-semibold break-words">{num} {r.player ?? ""}</span>
            {r.listSays ? <span className="block text-sm text-warn">The list says {r.listSays}. Check the name.</span> : null}
            {hasList && !r.onList ? <span className="block text-sm text-muted">Not on the catalog&apos;s list</span> : null}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone="accent">Owned{r.items.length > 1 ? ` x${r.items.length}` : ""}</Badge>
            {review ? <Badge tone="warn">In Review</Badge> : null}
          </span>
        </Link>
      </li>
    );
  }
  return (
    <li className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-3 py-1">
      <span className="min-w-0">
        <span className="block font-semibold break-words">{num} {r.player ?? ""}</span>
        <span className="block text-sm text-muted">{r.wanted ? "Wanted" : "Missing"}{r.team ? `, ${r.team}` : ""}</span>
      </span>
      {r.numberKey ? (
        <form action={toggleWantAction} className="shrink-0">
          <input type="hidden" name="key" value={setKey} />
          <input type="hidden" name="number" value={r.numberKey} />
          <input type="hidden" name="want" value={r.wanted ? "no" : "yes"} />
          <Button
            type="submit" variant={r.wanted ? "primary" : "secondary"} aria-pressed={r.wanted}
            aria-label={r.wanted ? `Stop wanting ${num} ${r.player ?? ""}` : `Want ${num} ${r.player ?? ""}`}
            className="min-w-24"
          >
            {r.wanted ? "Wanted" : "Want"}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export default async function SetPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const { key } = await params;
  if (!SET_KEY_RE.test(key) || key.length > 170) notFound();
  const sp = await searchParams;
  const asked = Array.isArray(sp.show) ? sp.show[0] : sp.show;
  const show: Show = (SHOWS as readonly string[]).includes(asked ?? "") ? (asked as Show) : "all";
  const view = setView(key);
  if (!view) notFound();

  const { set, checklist, counts } = view;
  const present = checklist?.present ?? false;
  const stopped = asFailure(set?.lastStop);
  // The last try stopped after the stored list (or with no list yet): say so.
  const showStop = stopped && set?.lastTryAt && (!set.checklistAt || set.lastTryAt.getTime() > set.checklistAt.getTime());
  const notInCatalog = !present && set?.notInCatalogAt != null && !showStop;
  const rows = view.rows.filter((r) => (show === "owned" ? r.owned : show === "missing" ? !r.owned && r.onList : show === "wanted" ? r.wanted : true));
  const missingCount = view.rows.filter((r) => !r.owned).length;
  const tabs: { show: Show; label: string; n: number | null }[] = [
    { show: "all", label: "All", n: null },
    { show: "owned", label: "Owned", n: counts.owned },
    ...(present ? [{ show: "missing" as Show, label: "Missing", n: counts.missing }] : []),
    { show: "wanted", label: "Wanted", n: counts.wanted },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/sets" className="inline-flex min-h-11 items-center text-base font-semibold text-accent">All sets</Link>
        <PageHeader
          title={view.label}
          subtitle={`${plural(counts.owned, "card", "cards")} owned${counts.inReview > 0 ? `, ${counts.inReview} still in Review` : ""}`}
        />
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Checklist</h2>
        {present && checklist ? (
          <>
            {view.percent != null ? (
              <div className="flex flex-col gap-1">
                <p className="text-3xl font-bold tabular">{view.percent}% complete</p>
                <div
                  role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-label="Percent complete"
                  className="h-3 w-full overflow-hidden rounded-full bg-surface-2"
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${view.percent}%` }} />
                </div>
                <p className="text-sm">You have {counts.ownedOnList.toLocaleString("en-US")} of the {checklist.listed.toLocaleString("en-US")} cards.</p>
              </div>
            ) : (
              <>
                <Notice tone="warn">
                  {MAY_BE_INCOMPLETE}.{" "}
                  {checklist.total != null && checklist.total > checklist.listed
                    ? `The free catalog sent ${checklist.listed.toLocaleString("en-US")} of the set's ${checklist.total.toLocaleString("en-US")} cards, so no percent is shown.`
                    : "Some card numbers are not on it, so no percent is shown."}
                </Notice>
                <p className="text-sm">
                  You have {counts.ownedOnList.toLocaleString("en-US")} of the {checklist.listed.toLocaleString("en-US")} cards on this list.
                </p>
              </>
            )}
            <p className="text-sm text-muted">From the free card catalog, fetched on {day(checklist.at)}. Kept on this server for {CHECKLIST_KEEP_DAYS} days.</p>
          </>
        ) : checklist?.expired ? (
          <p className="text-sm">The checklist fetched on {day(checklist.at)} was cleared after {CHECKLIST_KEEP_DAYS} days. Get it again to see what is missing.</p>
        ) : notInCatalog ? (
          <Notice tone="neutral">{NOT_IN_CATALOG}</Notice>
        ) : (
          <p className="text-sm">
            See which cards of this set you are missing. The app asks the free card catalog for this one set and keeps the list on this server, so this page works afterwards without asking again.
          </p>
        )}
        {showStop && stopped ? (
          <Notice tone="warn">
            {stoppedLine(stopped)} {set?.lastTryAt ? <>Last try: <LocalTime ms={set.lastTryAt.getTime()} />.</> : null}
          </Notice>
        ) : null}
        <GetChecklist setKey={key} again={present || Boolean(checklist?.expired) || notInCatalog} />
      </Card>

      <nav aria-label="Show" className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link
            key={t.show} href={t.show === "all" ? `/sets/${key}` : `/sets/${key}?show=${t.show}`}
            aria-current={show === t.show ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${show === t.show ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-text"}`}
          >
            {t.label}{t.n != null ? ` ${t.n.toLocaleString("en-US")}` : ""}
          </Link>
        ))}
      </nav>

      {missingCount > 0 ? (
        <div className="flex flex-col gap-2">
          <CopyMissing text={missingText(view)} count={missingCount} />
          <a
            href={`/api/sets/${key}/missing`} download
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-base font-semibold text-text"
          >
            Download missing and wanted (CSV)
          </a>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => <Row key={r.numberKey ?? `${r.cardNumber}-${r.player}`} r={r} setKey={key} hasList={present} />)}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {show === "wanted" ? (present ? "No wanted cards yet. Tap Want on a missing card." : "No wanted cards. Get the checklist to mark the cards you want.") : show === "missing" ? "Nothing missing on this list." : "No cards with a number in this set."}
        </p>
      )}

      {view.noNumber.length > 0 && (show === "all" || show === "owned") ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Owned, number not known</h2>
          <p className="text-sm text-muted">Add the card number on the card&apos;s page to place it on the list.</p>
          <ul className="flex flex-col gap-2">
            {view.noNumber.map((c) => (
              <li key={c.id}>
                <Link href={`/items/${c.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2">
                  <span className="min-w-0 font-semibold break-words">{c.player ?? c.title}</span>
                  {c.inReview ? <Badge tone="warn">In Review</Badge> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
