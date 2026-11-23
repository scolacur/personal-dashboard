<script lang="ts">
  import type { RunReport } from '@dashboard/shared';
  import VelocityChart from './VelocityChart.svelte';
  import { fmtPct, hasRuns, sliceRange, type VelocityRange } from './velocity-view';

  /**
   * Velocity › Robot loop (PD-862): per-week loop health from `agent_runs`. A run is one Robot
   * attempt. Succeeded = handed off a PR; failed = no-verify or error; parked = asked a human,
   * which is neither.
   */
  interface Props {
    report: RunReport | null;
    range: VelocityRange;
  }
  let { report, range }: Props = $props();

  const weeks = $derived(report ? sliceRange(report.weeks, range) : []);
  const ws = $derived(weeks.map((w) => w.weekStart));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const mins = (v: number) => `${Math.round(v)}m`;

  const outcomes = $derived([
    {
      key: 'succeeded',
      label: 'Succeeded',
      tone: 'done' as const,
      values: weeks.map((w) => w.succeeded),
    },
    { key: 'failed', label: 'Failed', tone: 'stuck' as const, values: weeks.map((w) => w.failed) },
    {
      key: 'parked',
      label: 'Asked a human',
      tone: 'park' as const,
      values: weeks.map((w) => w.parked),
    },
  ]);
  const faults = $derived([
    {
      key: 'transient',
      label: 'Transient',
      tone: 'warn' as const,
      values: weeks.map((w) => w.faults.transient),
    },
    {
      key: 'deterministic',
      label: 'Deterministic',
      tone: 'stuck' as const,
      values: weeks.map((w) => w.faults.deterministic),
    },
    {
      key: 'system-wide',
      label: 'System-wide',
      tone: 'text' as const,
      values: weeks.map((w) => w.faults['system-wide']),
    },
    {
      key: 'none',
      label: 'No tier',
      tone: 'neutral' as const,
      values: weeks.map((w) => w.faults.none),
    },
  ]);
  const one = (key: string, label: string, values: (number | null)[]) => [
    { key, label, tone: 'robot' as const, values },
  ];
</script>

<h2 class="velocity-section">Robot loop</h2>
{#if !report || !hasRuns(report)}
  <p class="velocity-empty">
    No Robot runs recorded yet. This section fills in once the loop has run.
  </p>
{:else}
  <p class="velocity-note">
    {report.totals.runs} runs: {report.totals.succeeded} succeeded, {report.totals.failed} failed,
    {report.totals.parked} asked a human. Overall success rate {fmtPct(
      report.totals.succeeded /
        Math.max(1, report.totals.succeeded + report.totals.failed + report.totals.parked),
    )}.
  </p>
  <div class="velocity-grid">
    <article class="card">
      <header class="card-head"><h3>Runs per week</h3></header>
      <VelocityChart
        weeks={ws}
        series={outcomes}
        kind="stacked"
        label="Robot runs per week by outcome"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Success rate</h3></header>
      <VelocityChart
        weeks={ws}
        series={one(
          'success',
          'Success rate',
          weeks.map((w) => w.successRate),
        )}
        yMax={1}
        format={pct}
        label="Share of finished runs that handed off a PR, per week"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Turns used vs cap</h3></header>
      <VelocityChart
        weeks={ws}
        series={one(
          'turns',
          'Turns / cap',
          weeks.map((w) => w.meanTurnRatio),
        )}
        yMax={1}
        format={pct}
        label="Mean share of the turn cap each run used, per week"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Retry rate</h3></header>
      <VelocityChart
        weeks={ws}
        series={one(
          'retry',
          'Retry rate',
          weeks.map((w) => w.retryRate),
        )}
        yMax={1}
        format={pct}
        label="Share of tickets that needed more than one run that week"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Failures by fault tier</h3></header>
      <VelocityChart
        weeks={ws}
        series={faults}
        kind="stacked"
        label="Failed runs per week by fault tier"
      />
    </article>
    <article class="card">
      <header class="card-head"><h3>Run duration</h3></header>
      <VelocityChart
        weeks={ws}
        series={one(
          'duration',
          'Mean duration',
          weeks.map((w) => w.meanDurationMin),
        )}
        format={mins}
        label="Mean minutes per finished run, per week"
      />
    </article>
  </div>
{/if}

<style lang="scss" src="./RobotLoopSection.scss"></style>
