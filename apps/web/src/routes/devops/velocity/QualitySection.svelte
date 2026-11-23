<script lang="ts">
  import { BUG_SEVERITY_LABELS, type BugReport, type SeverityCounts } from '@dashboard/shared';
  import VelocityChart from './VelocityChart.svelte';
  import { sliceRange, type VelocityRange } from './velocity-view';

  /**
   * Velocity › Quality (PD-881): are harness and guardrail changes making the codebase more robust?
   * Bugs filed vs fixed per week, open bugs by severity (= priority), and time to fix. A bug is a
   * ticket with Kind = Bug (PD-896). "Introduced" isn't observable from the board; filed is.
   */
  interface Props {
    report: BugReport | null;
    range: VelocityRange;
  }
  let { report, range }: Props = $props();

  const weeks = $derived(report ? sliceRange(report.weeks, range) : []);
  const ws = $derived(weeks.map((w) => w.weekStart));
  const total = (c: SeverityCounts) => c.high + c.medium + c.low;
  // Two decimals under a day, so a 0.25d axis tick doesn't read as 0.3d.
  const days = (v: number) => `${v < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10}d`;

  const flow = $derived([
    {
      key: 'filed',
      label: 'Filed',
      tone: 'stuck' as const,
      dashed: true,
      values: weeks.map((w) => total(w.filed)),
    },
    {
      key: 'fixed',
      label: 'Fixed',
      tone: 'done' as const,
      values: weeks.map((w) => total(w.fixed)),
    },
  ]);
  const open = $derived([
    {
      key: 'high',
      label: BUG_SEVERITY_LABELS.high,
      tone: 'stuck' as const,
      values: weeks.map((w) => w.open.high),
    },
    {
      key: 'medium',
      label: BUG_SEVERITY_LABELS.medium,
      tone: 'warn' as const,
      values: weeks.map((w) => w.open.medium),
    },
    {
      key: 'low',
      label: BUG_SEVERITY_LABELS.low,
      tone: 'neutral' as const,
      values: weeks.map((w) => w.open.low),
    },
  ]);
  const ttf = $derived([
    {
      key: 'ttf',
      label: 'Median days to fix',
      tone: 'accent' as const,
      values: weeks.map((w) => w.medianDaysToFix),
    },
  ]);
</script>

<h2 class="velocity-section">Quality</h2>
{#if !report || report.totals.bugs === 0}
  <p class="velocity-empty">
    No tickets are marked as bugs yet. Set a ticket's Kind to Bug and it will show here.
  </p>
{:else}
  <p class="velocity-note">
    {total(report.totals.openNow)} open bugs ({report.totals.openNow.high} at P0–P1) · {report
      .totals.fixed} of
    {report.totals.bugs} fixed. Counts tickets whose Kind is Bug. Older bugs were tagged from their titles,
    so correct a ticket's Kind if it's wrong.
  </p>
  <div class="velocity-grid">
    <article class="card">
      <header class="card-head"><h3>Bugs filed vs fixed</h3></header>
      <VelocityChart weeks={ws} series={flow} label="Bugs filed and fixed per week" />
      <p class="card-note">
        Fixed means completed. A bug closed as won't-fix or duplicate isn't counted as fixed.
      </p>
    </article>
    <article class="card">
      <header class="card-head"><h3>Open bugs by severity</h3></header>
      <VelocityChart
        weeks={ws}
        series={open}
        kind="stacked"
        label="Open bugs at the end of each week, by priority"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Time to fix</h3></header>
      <VelocityChart
        weeks={ws}
        series={ttf}
        format={days}
        label="Median days from filing to fix, by week fixed"
      />
    </article>
  </div>
{/if}

<style lang="scss" src="./QualitySection.scss"></style>
