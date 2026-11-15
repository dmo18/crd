import { formatCents } from "@/lib/money";
import type { DecadeStat } from "@/lib/items/stats";

/** Horizontal bars sized by each decade's share of total value. */
export function DecadeBars({ decades }: { decades: DecadeStat[] }) {
  const total = decades.reduce((sum, d) => sum + d.valueCents, 0);
  return (
    <ul className="flex flex-col gap-3">
      {decades.map((d) => {
        const pct = total > 0 ? Math.round((d.valueCents / total) * 100) : 0;
        return (
          <li key={d.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-semibold">{d.label}</span>
              <span className="tabular text-muted">{formatCents(d.valueCents)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
