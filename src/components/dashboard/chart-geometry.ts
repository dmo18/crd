export type ChartPoint = { day: string; valueCents: number };

export type ChartGeometry = {
  /** Plot area inside the SVG, leaving room for axis labels. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Line path, e.g. "M10 20 L30 40". Empty when there are no points. */
  line: string;
  /** Closed path under the line for the soft fill. */
  area: string;
  dots: { x: number; y: number }[];
  /** Gridlines from top to bottom, with the value each one stands for. */
  ticks: { y: number; valueCents: number }[];
};

/** A rounded step (1, 2 or 5 times a power of ten) so axis labels look tidy. */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

const num = (n: number) => Number(n.toFixed(2));

/** Pure scale and path maths for the value chart. Handles empty, single and flat series. */
export function chartGeometry(points: { valueCents: number }[], width: number, height: number): ChartGeometry {
  const plot = { left: 52, right: width - 16, top: 14, bottom: height - 26 };
  if (points.length === 0) return { plot, line: "", area: "", dots: [], ticks: [] };

  const values = points.map((p) => p.valueCents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Work in dollars so the steps are tidy; always at least 1 dollar of range.
  const minD = min / 100;
  const maxD = Math.max(max / 100, minD + 1);
  const step = niceStep((maxD - minD) / 2);
  const lo = Math.floor(minD / step) * step;
  let hi = Math.ceil(maxD / step) * step;
  if (hi <= lo) hi = lo + step;

  const y = (cents: number) => plot.bottom - ((cents / 100 - lo) / (hi - lo)) * (plot.bottom - plot.top);
  const xAt = (i: number) =>
    points.length === 1 ? (plot.left + plot.right) / 2 : plot.left + (i / (points.length - 1)) * (plot.right - plot.left);

  const dots = points.map((p, i) => ({ x: num(xAt(i)), y: num(y(p.valueCents)) }));
  const line = dots.map((d, i) => `${i === 0 ? "M" : "L"}${d.x} ${d.y}`).join(" ");
  const first = dots[0];
  const last = dots[dots.length - 1];
  const area = `${line} L${last.x} ${plot.bottom} L${first.x} ${plot.bottom} Z`;

  const ticks: ChartGeometry["ticks"] = [];
  for (let v = hi; v >= lo - step / 1000; v -= step) {
    const cents = Math.round(v * 100);
    ticks.push({ y: num(y(cents)), valueCents: cents });
  }
  return { plot, line, area, dots, ticks };
}
