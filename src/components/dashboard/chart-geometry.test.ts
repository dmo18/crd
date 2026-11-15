import { describe, expect, it } from "vitest";
import { chartGeometry } from "./chart-geometry";

const pts = (...v: number[]) => v.map((valueCents, i) => ({ day: `2026-01-0${i + 1}`, valueCents }));

describe("chartGeometry", () => {
  it("handles no points", () => {
    const g = chartGeometry([], 320, 160);
    expect(g.line).toBe("");
    expect(g.dots).toEqual([]);
  });
  it("centers a single point", () => {
    const g = chartGeometry(pts(5000), 320, 160);
    expect(g.dots).toHaveLength(1);
    expect(Number.isFinite(g.dots[0].y)).toBe(true);
    expect(g.dots[0].x).toBe((g.plot.left + g.plot.right) / 2);
  });
  it("does not divide by zero on a flat series", () => {
    const g = chartGeometry(pts(10000, 10000, 10000), 320, 160);
    expect(g.line).not.toMatch(/NaN|Infinity/);
    expect(g.ticks.length).toBeGreaterThanOrEqual(2);
    for (const d of g.dots) expect(d.y).toBeGreaterThanOrEqual(g.plot.top);
  });
  it("puts higher values higher up and spans the plot width", () => {
    const g = chartGeometry(pts(10000, 30000), 320, 160);
    expect(g.dots[1].y).toBeLessThan(g.dots[0].y);
    expect(g.dots[0].x).toBe(g.plot.left);
    expect(g.dots[1].x).toBe(g.plot.right);
  });
  it("uses tidy gridline values that cover the data", () => {
    const g = chartGeometry(pts(12300, 87600), 320, 160);
    const vals = g.ticks.map((t) => t.valueCents / 100);
    expect(Math.max(...vals)).toBeGreaterThanOrEqual(876);
    expect(Math.min(...vals)).toBeLessThanOrEqual(123);
    expect(g.ticks.length).toBeLessThanOrEqual(5);
    expect(vals.every((v) => v % 50 === 0 || v % 100 === 0 || v % 20 === 0)).toBe(true);
  });
});
