<script lang="ts">
  import type {
    AgentProject,
    BugReport,
    EpicBurndown,
    IntroductionReport,
    RunReport,
    VelocityReport,
  } from '@dashboard/shared';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import { fetchProjects } from '../api';
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
    fmtSigned,
    netFlow,
    longDate,
    parseProjectParam,
    projectSearch,
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
  let flowView = $state<'lines' | 'net'>('lines');

  let projects = $state<AgentProject[]>([]);
  let loading = $state(false);

  // PD-922: the project filter lives in the URL, so a filtered view is linkable and survives reload.
  const projectId = $derived(parseProjectParam(page.url.searchParams.get('project')));

  function setProject(id: number | undefined) {
    void goto(`${page.url.pathname}${projectSearch(page.url.searchParams, id)}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  $effect(() => {
    fetchProjects()
      .then((p) => (projects = p))
      .catch(() => {
        /* the filter just offers "All projects" */
      });
  });

  // Refetch on every project change. The previous data stays up while loading, and only the latest
  // request may land — a slow response for an old choice must not overwrite a newer one.
  let request = 0;
  $effect(() => {
    const pid = projectId;
    const seq = ++request;
    loading = true;
    error = null;
    Promise.all([
      fetchVelocity(pid),
      fetchRunReport(pid),
      fetchEpicBurndowns(pid),
      fetchBugReport(pid),
      fetchIntroductions(pid),
    ])
      .then(([v, r, e, b, i]) => {
        if (seq !== request) return;
        introductions = i;
        report = v;
        runs = r;
        epics = e;
        bugs = b;
      })
      .catch((e: unknown) => {
        if (seq !== request) return;
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        if (seq === request) loading = false;
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

  // PD-923: one signed bar per week — the first bar above zero is the week the backlog shrank.
  const net = $derived([
    { key: 'net', label: 'Net change', tone: 'gain' as const, values: netFlow(weeks) },
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

<section class="velocity-page" aria-busy={loading}>
  <header class="velocity-head">
    <h1 class="velocity-title">Velocity</h1>
    <a class="velocity-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="velocity-sub">
    How fast work moves through the board, and how the Robot loop is doing. Weeks run Monday to
    Sunday, Eastern.
  </p>

  <div class="velocity-filters">
    <label class="velocity-project">
      <select
        aria-label="Project"
        value={projectId === undefined ? '' : String(projectId)}
        onchange={(e) => setProject(parseProjectParam(e.currentTarget.value))}
      >
        <option value="">All projects</option>
        {#each projects as p (p.id)}<option value={String(p.id)}>{p.name}</option>{/each}
        {#if projectId !== undefined && !projects.some((p) => p.id === projectId)}
          <option value={String(projectId)}>Project {projectId}</option>
        {/if}
      </select>
    </label>
    <SegmentedToggle
      label="Time range"
      options={VELOCITY_RANGES}
      value={range}
      onChange={(v) => (range = v)}
    />
    {#if loading && report}<span class="velocity-updating" aria-live="polite">Updating…</span>{/if}
  </div>

  {#if error}
    <p class="velocity-error" role="alert">Couldn't load velocity: {error}</p>
  {:else if !report || !tiles}
    <p class="velocity-loading">Loading…</p>
  {:else}
    {#if report.startDate !== null}
      <p class="velocity-note">
        History starts <strong>{longDate(report.startDate)}</strong>, the first completion in the
        event log. Earlier work has no completion record and isn't counted. Completions are credited
        to whoever <em>opened the PR</em> (a <code>robot/</code> branch is the Robot's, so a PR of
        yours the Robot reworked stays yours); the burndown splits by <em>current</em> assignee.
      </p>
    {/if}

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
        <header class="card-head">
          <h3>Created vs resolved</h3>
          <SegmentedToggle
            label="Lines or net change"
            options={[
              { value: 'lines', label: 'Lines' },
              { value: 'net', label: 'Net' },
            ]}
            value={flowView}
            onChange={(v) => (flowView = v)}
          />
        </header>
        {#if flowView === 'lines'}
          <VelocityChart weeks={ws} series={flow} label="Tickets created and resolved per week" />
          <p class="card-note">
            Resolved means completed or closed. Above the created line, the backlog is shrinking.
          </p>
        {:else}
          <VelocityChart
            weeks={ws}
            series={net}
            kind="diverging"
            format={fmtSigned}
            signLabels={['Backlog shrank', 'Backlog grew']}
            label="Net change in open tickets per week: resolved minus created"
          />
          <p class="card-note">
            Resolved minus created. Above zero, more was resolved than created that week, so the
            backlog shrank.
          </p>
        {/if}
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
