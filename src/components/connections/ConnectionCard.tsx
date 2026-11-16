import { LocalTime } from "@/components/activity/LocalTime";
import { Badge, Card, Notice } from "@/components/ui";
import type { ConnectionView } from "@/lib/outside/view";
import { ClearForm, KeyForm, RemoveKeyForm, ReplaceKey, SwitchForm, TestForm } from "./ActionForms";

/**
 * One outside source on More, Connections: state, switch, Test, Clear stored
 * answers, the key (for a source that uses one) and the usage view.
 * `view` never holds a key, only its last 4 characters once saved.
 */

const n = (v: number) => v.toLocaleString("en-US");

function StateBadge({ view }: { view: ConnectionView }) {
  const s = view.state;
  switch (s.kind) {
    case "on": return <Badge tone="accent">On</Badge>;
    case "off": return <Badge>Off</Badge>;
    case "paused": return <Badge tone="warn">Paused</Badge>;
    case "needs_key": return <Badge tone="warn">Needs a key</Badge>;
    case "enter_again": return <Badge tone="danger">Needs a key</Badge>;
  }
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function Usage({ view }: { view: ConnectionView }) {
  const u = view.usage;
  return (
    <section aria-label={`Usage of ${view.name}`} className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Usage</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Calls today</dt>
        <dd className="text-right font-semibold">{u.perDay === null ? n(u.callsToday) : `${n(u.callsToday)} of ${n(u.perDay)}`}</dd>
        <dt className="text-muted">Calls this hour</dt>
        <dd className="text-right font-semibold">{u.perHour === null ? n(u.callsThisHour) : `${n(u.callsThisHour)} of ${n(u.perHour)}`}</dd>
        <dt className="text-muted">Taken from stored answers today</dt>
        <dd className="text-right font-semibold">{n(u.storeHitsToday)}</dd>
        <dt className="text-muted">Errors today</dt>
        <dd className="text-right font-semibold">{n(u.errorsToday)}</dd>
        <dt className="text-muted">Last good call</dt>
        <dd className="text-right font-semibold">{u.lastOkAtMs === null ? "Never" : <LocalTime ms={u.lastOkAtMs} />}</dd>
        <dt className="text-muted">Stored answers</dt>
        <dd className="text-right font-semibold">{n(view.stored.answers)}</dd>
      </dl>
      {u.lastError ? <p className="text-sm text-muted">Last problem: {u.lastError}.</p> : null}
      <details className="text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-accent">Calls per day, last 7 days</summary>
        <table className="w-full">
          <caption className="sr-only">Calls per day for {view.name}, days in UTC</caption>
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 font-normal">Day (UTC)</th>
              <th scope="col" className="py-1 text-right font-normal">Calls</th>
              <th scope="col" className="py-1 text-right font-normal">Stored</th>
              <th scope="col" className="py-1 text-right font-normal">Errors</th>
            </tr>
          </thead>
          <tbody>
            {u.days.map((d) => (
              <tr key={d.day} className="border-t border-border">
                <td className="py-1">{dayLabel(d.day)}</td>
                <td className="py-1 text-right">{n(d.calls)}</td>
                <td className="py-1 text-right">{n(d.storeHits)}</td>
                <td className="py-1 text-right">{n(d.errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function KeyPart({ view, hint }: { view: ConnectionView; hint: string }) {
  const k = view.key;
  if (!k) return null;
  return (
    <section aria-label={`Key of ${view.name}`} className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Key</h3>
      {k.state === "none" ? (
        <>
          <p className="text-sm text-muted">Paste the key once. It is locked on this server and never shown again.</p>
          <KeyForm source={view.id} name={view.name} hint={hint} replacing={false} />
        </>
      ) : k.state === "enter_again" ? (
        <>
          <Notice tone="danger">This key must be entered again. The server setting that locks keys has changed.</Notice>
          <KeyForm source={view.id} name={view.name} hint={hint} replacing />
          <RemoveKeyForm source={view.id} name={view.name} />
        </>
      ) : (
        <>
          <p className="text-sm">
            {`Saved, ends in ...${k.last4}, on `}<LocalTime ms={k.savedAtMs} />.
          </p>
          <p className="text-sm text-muted">
            {k.lastTestAtMs === null ? "Not tested yet." : (
              <>Last test {k.lastTestOk ? "worked" : "did not work"}: <LocalTime ms={k.lastTestAtMs} />.</>
            )}
          </p>
          <ReplaceKey source={view.id} name={view.name} hint={hint} />
          <RemoveKeyForm source={view.id} name={view.name} />
        </>
      )}
    </section>
  );
}

export function ConnectionCard({ view, keyHint }: { view: ConnectionView; keyHint: string }) {
  const s = view.state;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{view.name}</h2>
        <StateBadge view={view} />
      </div>
      <p className="text-sm text-muted">{view.usedFor}</p>
      {s.kind === "paused" ? (
        <Notice tone="warn">Paused until <LocalTime ms={s.untilMs} />{`: ${s.reason.toLowerCase()}.`}</Notice>
      ) : s.kind === "off" ? (
        <Notice>{`Switched off. The app makes no calls to ${view.name}.`}</Notice>
      ) : null}
      <KeyPart view={view} hint={keyHint} />
      <div className="grid gap-2">
        <TestForm source={view.id} name={view.name} />
        <SwitchForm source={view.id} name={view.name} enabled={view.enabled} />
        <ClearForm source={view.id} name={view.name} />
      </div>
      <Usage view={view} />
    </Card>
  );
}
