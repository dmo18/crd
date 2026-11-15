import { chartGeometry } from "./chart-geometry";
import { formatCents } from "@/lib/money";

type Snapshot = { day: string; totalValueCents: number };

const W = 320;
const H = 170;

function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function axisMoney(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${+(d / 1_000_000).toFixed(1)}M`;
  if (d >= 10_000) return `$${+(d / 1000).toFixed(0)}k`;
  if (d >= 1000) return `$${+(d / 1000).toFixed(1)}k`;
  return `$${Math.round(d)}`;
}

/** Line chart of collection value by day. Pure SVG, no client JavaScript. */
export function ValueChart({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length < 2) {
    return <p className="text-sm text-muted">The chart fills in as days go by. Check back tomorrow.</p>;
  }
  const points = snapshots.map((s) => ({ day: s.day, valueCents: s.totalValueCents }));
  const g = chartGeometry(points, W, H);
  const first = points[0];
  const last = points[points.length - 1];
  const dot = g.dots[g.dots.length - 1];
  const label = formatCents(last.valueCents);
  const labelAnchor = dot.x > W - 70 ? "end" : "middle";
  const labelX = labelAnchor === "end" ? dot.x : dot.x;
  const summary = `Collection value went from ${formatCents(first.valueCents)} on ${shortDate(first.day)} to ${formatCents(last.valueCents)} on ${shortDate(last.day)}.`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary} className="block h-auto text-accent">
        {g.ticks.map((t) => (
          <g key={t.y}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} className="stroke-border" strokeWidth="1" />
            <text x={g.plot.left - 6} y={t.y + 4} textAnchor="end" className="fill-muted" fontSize="10">
              {axisMoney(t.valueCents)}
            </text>
          </g>
        ))}
        <path d={g.area} className="fill-current" fillOpacity="0.15" />
        <path d={g.line} className="fill-none stroke-current" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={dot.x} cy={dot.y} r="4" className="fill-current" />
        <text x={labelX} y={Math.max(dot.y - 10, 10)} textAnchor={labelAnchor} className="fill-text" fontSize="11" fontWeight="600">
          {label}
        </text>
        <text x={g.plot.left} y={H - 8} textAnchor="start" className="fill-muted" fontSize="10">
          {shortDate(first.day)}
        </text>
        <text x={g.plot.right} y={H - 8} textAnchor="end" className="fill-muted" fontSize="10">
          {shortDate(last.day)}
        </text>
      </svg>
      <table className="sr-only">
        <caption>Collection value by day</caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Value</th></tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}><td>{p.day}</td><td>{formatCents(p.valueCents)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
