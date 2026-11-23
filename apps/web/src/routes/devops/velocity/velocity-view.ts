import type { AssigneeCounts, RunReport, VelocityReport } from '@dashboard/shared';

/**
 * Pure view logic for the Velocity page (Epic PD-895). apps/web has no DOM test runner, so the
 * parts worth testing live here, not in the components.
 */

/** Time window the page shows. `all` = since the first completion event. */
export type VelocityRange = '8w' | '26w' | 'all';
export const VELOCITY_RANGES: { value: VelocityRange; label: string }[] = [
  { value: '8w', label: '8 weeks' },
  { value: '26w', label: '26 weeks' },
  { value: 'all', label: 'All' },
];

/** The trailing `n` items for a range (weeks are oldest-first). */
export function sliceRange<T>(items: T[], range: VelocityRange): T[] {
  if (range === 'all') return items;
  const n = range === '8w' ? 8 : 26;
  return items.slice(-n);
}

/** A "nice" axis ceiling (1/2/2.5/5 × 10ⁿ) at or above `max`, and evenly spaced ticks to it. */
export function niceScale(max: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const rough = max / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  return { max: top, ticks };
}

export function sumCounts(c: AssigneeCounts): number {
  return c.robot + c.steve + c.unassigned;
}

/** Robot's share of robot + steve work, 0–1; null when neither did any. Unassigned is excluded:
 *  it is history from before assignment was tracked, not a third worker. */
export function robotShare(c: AssigneeCounts): number | null {
  const both = c.robot + c.steve;
  return both ? c.robot / both : null;
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

/** "Nov 16" — week labels on the x axis and in tooltips. Displayed in Eastern, like the buckets. */
export function weekLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

export function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

/** Headline numbers for the stat tiles. "This week" is the current (last, partial) bucket. */
export function velocityTiles(r: VelocityReport) {
  const last = r.weeks.at(-1);
  return {
    totalCompleted: sumCounts(r.totals.ticketsCompleted),
    epicsCompleted: sumCounts(r.totals.epicsCompleted),
    thisWeek: last ? sumCounts(last.ticketsCompleted) : 0,
    robotShare: robotShare(r.totals.ticketsCompleted),
    openNow: sumCounts(r.totals.openNow),
  };
}

/** Indices of the x-axis ticks to label so labels sit ≥ `minPx` apart; always includes the last. */
export function tickIndices(count: number, plotWidth: number, minPx = 64): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / minPx))));
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

/** Spread end-of-line labels vertically so none sit closer than `gap` px (input order kept). */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  }
  // If the stack ran off the bottom, push it back up.
  const overflow = order.length ? order[order.length - 1].y - max : 0;
  if (overflow > 0) for (const o of order) o.y -= overflow;
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = Math.max(min, o.y);
  return out;
}

/** True when the run report has any runs to show. */
export function hasRuns(r: RunReport | null): boolean {
  return !!r && r.totals.runs > 0;
}
