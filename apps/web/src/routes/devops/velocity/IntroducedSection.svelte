<script lang="ts">
  import type { IntroCandidate, IntroductionReport } from '@dashboard/shared';
  import VelocityChart from './VelocityChart.svelte';
  import { fmtNum, longDate, sliceRange, weekLabel, type VelocityRange } from './velocity-view';

  /**
   * Velocity › Quality › When bugs were introduced (PD-916). The agent-worker's SZZ job blames each
   * fixed bug's fix back to the commits that last wrote the changed lines; the one with the most
   * lines is credited. Suspects, not proof — every candidate is listed on expand. Recent weeks are
   * shaded: bugs written lately mostly haven't been found yet, so those bars will still grow.
   */
  interface Props {
    report: IntroductionReport | null;
    range: VelocityRange;
  }
  let { report, range }: Props = $props();

  const weeks = $derived(report ? sliceRange(report.weeks, range) : []);
  const series = $derived([
    {
      key: 'robot',
      label: 'Robot PRs',
      tone: 'robot' as const,
      values: weeks.map((w) => w.introduced.robot),
    },
    {
      key: 'human',
      label: 'Hand-built PRs',
      tone: 'steve' as const,
      values: weeks.map((w) => w.introduced.human),
    },
  ]);
  const traced = $derived(report ? report.bugs.filter((b) => b.top) : []);
  const days = (from: number, to: number) => Math.max(0, Math.round((to - from) / 86_400_000));
  const who = (c: IntroCandidate) => (c.robot ? 'Robot' : 'Hand-built');
  const per100 = (v: number | null) => (v === null ? '—' : fmtNum(v, 1));
</script>

<h3 class="intro-title">When bugs were introduced</h3>
{#if !report || report.computedAt === null}
  <p class="velocity-empty">
    Not computed yet. The agent-worker's SZZ job fills this in on its next run.
  </p>
{:else}
  <p class="velocity-note">
    Each fixed bug is traced through <code>git blame</code> from its fix back to the PR that last
    wrote the lines the fix changed. These are suspects, not proof; expand a row to see every
    candidate. Recomputed
    {longDate(report.computedAt)}.
  </p>
  <div class="intro-tiles">
    <div class="tile">
      <span class="tile-label">Typical time undetected</span>
      <span class="tile-value"
        >{report.medianLagDays === null ? '—' : `${Math.round(report.medianLagDays)}d`}</span
      >
      <span class="tile-meta">median, introduced → filed</span>
    </div>
    <div class="tile">
      <span class="tile-label">Bugs per 100 PRs</span>
      <span class="tile-value"
        >{per100(report.per100.robot)} <small>Robot</small> · {per100(report.per100.human)}
        <small>hand-built</small></span
      >
      <span class="tile-meta">
        {report.settled.robotBugs} in {report.settled.robotPrs} Robot PRs · {report.settled
          .humanBugs} in
        {report.settled.humanPrs} hand-built · settled weeks only
      </span>
    </div>
    <div class="tile">
      <span class="tile-label">Fixed bugs traced</span>
      <span class="tile-value">{report.counts.traced} <small>of {report.bugs.length}</small></span>
      <span class="tile-meta">
        {report.counts.untraceable} fix only added code · {report.counts.unlinked} no fix commit found
      </span>
    </div>
  </div>

  <article class="card">
    <header class="card-head"><h3>Bugs introduced per week</h3></header>
    <VelocityChart
      weeks={weeks.map((w) => w.weekStart)}
      {series}
      kind="stacked"
      shadeFrom={report.accumulatingFrom}
      label="Bugs introduced per week, by whether the introducing PR was built by the Robot"
    />
    <p class="card-note">
      Dated by when the suspect PR merged. Shaded weeks are newer than the typical time a bug goes
      unnoticed, so they will keep growing as bugs are found.
    </p>
  </article>

  {#if traced.length}
    <div class="intro-table-wrap">
      <table class="intro-table">
        <thead>
          <tr>
            <th scope="col">Bug</th>
            <th scope="col">Introduced by</th>
            <th scope="col">Merged</th>
            <th scope="col">Undetected</th>
          </tr>
        </thead>
        <tbody>
          {#each traced as b (b.ticketId)}
            {@const top = b.top as IntroCandidate}
            <tr>
              <td>
                <a href="/devops/tickets/{b.displayId}">{b.displayId}</a>
                <span class="bug-title">{b.title.replace(/^(\[[^\]]+\]\s*)+/, '')}</span>
              </td>
              <td>
                <details>
                  <summary>
                    {#if top.tickets[0]}<a href="/devops/tickets/{top.tickets[0]}"
                        >{top.tickets[0]}</a
                      >{/if}
                    {top.prNumber ? `#${top.prNumber}` : top.sha.slice(0, 7)} · {who(top)}
                    <span class="muted">({top.lines} lines)</span>
                  </summary>
                  <ul class="cands">
                    {#each b.candidates as c (c.sha)}
                      <li>
                        {c.tickets.join(', ') || c.sha.slice(0, 7)}
                        {c.prNumber ? `#${c.prNumber}` : ''} · {who(c)} · {weekLabel(c.committedAt)} ·
                        {c.lines} lines
                      </li>
                    {/each}
                  </ul>
                </details>
              </td>
              <td>{weekLabel(top.committedAt)}</td>
              <td>{days(top.committedAt, b.filedAt)}d</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style lang="scss" src="./IntroducedSection.scss"></style>
