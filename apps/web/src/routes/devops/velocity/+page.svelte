<script lang="ts">
  import type {
    BugReport,
    EpicBurndown,
    IntroductionReport,
    RunReport,
    VelocityReport,
  } from '@dashboard/shared';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import VelocityChart from './VelocityChart.svelte';
  import RobotLoopSection from './RobotLoopSection.svelte';
  import EpicBurndownSection from './EpicBurndownSection.svelte';
  import QualitySection from './QualitySection.svelte';
  import IntroducedSection from './IntroducedSection.svelte';
  import {
    fetchBugReport,
    fetchEpicBurndowns,
    fetchIntroductions,
    fetchRunReport,
    fetchVelocity,
  } from './api';
  import {
    VELOCITY_RANGES,
    fmtNum,
    fmtPct,
    longDate,
    sliceRange,
    velocityTiles,
    type VelocityRange,
  } from './velocity-view';

  /**
   * Dev Ops › Velocity (Epic PD-895, slices PD-861 + PD-862): is the loop making development faster?
   * Throughput, burndown and cycle time from the board's event log; Robot-loop health from
   * `agent_runs`. History starts at the first completion event — nothing is backfilled.
   */

  let report = $state<VelocityReport | null>(null);
  let runs = $state<RunReport | null>(null);
  let epics = $state<EpicBurndown[]>([]);
  let bugs = $state<BugReport | null>(null);
  let introductions = $state<IntroductionReport | null>(null);
  let error = $state<string | null>(null);
  let range = $state<VelocityRange>('26w');
  let throughputKind = $state<'tickets' | 'epics'>('tickets');

  $effect(() => {
    Promise.all([
      fetchVelocity(),
      fetchRunReport(),
      fetchEpicBurndowns(),
      fetchBugReport(),
      fetchIntroductions(),
    ])
      .then(([v, r, e, b, i]) => {
        introductions = i;
        report = v;
        runs = r;
        epics = e;
        bugs = b;
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      });
  });

  const weeks = $derived(report ? sliceRange(report.weeks, range) : []);
  const ws = $derived(weeks.map((w) => w.weekStart));
  const tiles = $derived(report ? velocityTiles(report) : null);

  const throughput = $derived.by(() => {
    const pick = (w: (typeof weeks)[number]) =>
      throughputKind === 'tickets' ? w.ticketsCompleted : w.epicsCompleted;
    return [
      {
        key: 'robot',
        label: 'Robot',
        tone: 'robot' as const,
        values: weeks.map((w) => pick(w).robot),
      },
      {
        key: 'steve',
        label: 'Steve',
        tone: 'steve' as const,
        values: weeks.map((w) => pick(w).steve),
      },
      {
        key: 'unassigned',
        label: 'Unassigned',
        tone: 'neutral' as const,
        values: weeks.map((w) => pick(w).unassigned),
      },
    ];
  });

  const burndown = $derived([
    {
      key: 'total',
      label: 'All open',
      tone: 'text' as const,
      values: weeks.map((w) => w.open.robot + w.open.steve + w.open.unassigned),
    },
    {
      key: 'robot',
      label: 'Robot',
      tone: 'robot' as const,
      values: weeks.map((w) => w.open.robot),
    },
    {
      key: 'steve',
      label: 'Steve',
      tone: 'steve' as const,
      dashed: true,
      values: weeks.map((w) => w.open.steve),
    },
    {
      key: 'unassigned',
      label: 'Unassigned',
      tone: 'neutral' as const,
      values: weeks.map((w) => w.open.unassigned),
    },
  ]);

  const flow = $derived([
    {
      key: 'created',
      label: 'Created',
      tone: 'neutral' as const,
      dashed: true,
      values: weeks.map((w) => w.created),
    },
    {
      key: 'resolved',
      label: 'Resolved',
      tone: 'text' as const,
      values: weeks.map((w) => w.resolved),
    },
  ]);

  const cycle = $derived([
    {
      key: 'median',
      label: 'Median',
      tone: 'accent' as const,
      values: weeks.map((w) => w.cycleMedianDays),
    },
    {
      key: 'p75',
      label: '75th pct',
      tone: 'neutral' as const,
      dashed: true,
      values: weeks.map((w) => w.cycleP75Days),
    },
  ]);

  const days = (v: number) => `${Math.round(v * 10) / 10}d`;
</script>

<section class="velocity-page">
  <header class="velocity-head">
    <h1 class="velocity-title">Velocity</h1>
    <a class="velocity-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="velocity-sub">
    How fast work moves through the board, and how the Robot loop is doing. Weeks run Monday to
    Sunday, Eastern.
  </p>

  {#if error}
    <p class="velocity-error" role="alert">Couldn't load velocity: {error}</p>
  {:else if !report || !tiles}
    <p class="velocity-loading">Loading…</p>
  {:else}
    {#if report.startDate !== null}
      <p class="velocity-note">
        History starts <strong>{longDate(report.startDate)}</strong>, the first completion in the
        event log. Earlier work has no completion record and isn't counted. Splits use each ticket's
        <em>current</em> assignee.
      </p>
    {/if}

    <div class="velocity-filters">
      <SegmentedToggle
        label="Time range"
        options={VELOCITY_RANGES}
        value={range}
        onChange={(v) => (range = v)}
      />
    </div>

    <div class="velocity-tiles">
      <div class="tile">
        <span class="tile-label">Tickets completed</span>
        <span class="tile-value">{tiles.totalCompleted}</span>
        <span class="tile-meta">+ {tiles.epicsCompleted} Epics</span>
      </div>
      <div class="tile">
        <span class="tile-label">This week</span>
        <span class="tile-value">{tiles.thisWeek}</span>
        <span class="tile-meta">tickets completed so far</span>
      </div>
      <div class="tile">
        <span class="tile-label">Robot share</span>
        <span class="tile-value">{fmtPct(tiles.robotShare)}</span>
        <span class="tile-meta">of robot + Steve completions</span>
      </div>
      <div class="tile">
        <span class="tile-label">Open now</span>
        <span class="tile-value">{tiles.openNow}</span>
        <span class="tile-meta">non-Epic tickets</span>
      </div>
    </div>

    <h2 class="velocity-section">Board</h2>
    <div class="velocity-grid">
      <article class="card">
        <header class="card-head">
          <h3>Completed per week</h3>
          <SegmentedToggle
            label="Tickets or Epics"
            options={[
              { value: 'tickets', label: 'Tickets' },
              { value: 'epics', label: 'Epics' },
            ]}
            value={throughputKind}
            onChange={(v) => (throughputKind = v)}
          />
        </header>
        <VelocityChart
          weeks={ws}
          series={throughput}
          kind="stacked"
          label="{throughputKind === 'tickets'
            ? 'Tickets'
            : 'Epics'} completed per week, by assignee"
        />
      </article>

      <article class="card">
        <header class="card-head"><h3>Burndown: open tickets</h3></header>
        <VelocityChart weeks={ws} series={burndown} label="Open tickets at the end of each week" />
      </article>

      <article class="card">
        <header class="card-head"><h3>Created vs resolved</h3></header>
        <VelocityChart weeks={ws} series={flow} label="Tickets created and resolved per week" />
        <p class="card-note">
          Resolved means completed or closed. Above the created line, the backlog is shrinking.
        </p>
      </article>

      <article class="card">
        <header class="card-head"><h3>Cycle time</h3></header>
        <VelocityChart
          weeks={ws}
          series={cycle}
          format={days}
          label="Days from created to completed, by week of completion"
        />
        <p class="card-note">
          Days from creation to first completion, for tickets completed that week. Latest median:
          {fmtNum(weeks.findLast((w) => w.cycleMedianDays !== null)?.cycleMedianDays, 1)}d.
        </p>
      </article>
    </div>

    <QualitySection report={bugs} {range} />
    <IntroducedSection report={introductions} {range} />

    <EpicBurndownSection {epics} {range} />

    <RobotLoopSection report={runs} {range} />
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
