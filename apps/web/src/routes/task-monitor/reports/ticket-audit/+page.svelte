<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProject, AgentTicket, AuditFinding, AuditRun } from '@dashboard/shared';
  import { fetchAuditRuns, fetchRunFindings } from '$lib/audit-api';
  import { latestRun, pickReportRun, isRunInFlight, openActionableFindings } from '$lib/audit-logic';
  import { runStatusLabel, runStatusColor, formatTs } from '$lib/audit-display';
  import { fetchProjects, fetchTickets } from '../../api';
  import AuditReport from './AuditReport.svelte';

  const HISTORY_LIMIT = 10;

  let loading = $state(true);
  let error = $state<string | null>(null);
  let runs = $state<AuditRun[]>([]);
  let reportRun = $state<AuditRun | null>(null);
  let findings = $state<AuditFinding[]>([]);
  let projects = $state<AgentProject[]>([]);
  let tickets = $state<AgentTicket[]>([]);

  const newest = $derived(latestRun(runs));
  // A run kicked off after the one we're showing — surface that fresher results are coming.
  const runningNewer = $derived(
    isRunInFlight(newest) && (!reportRun || (newest && newest.id !== reportRun.id)),
  );
  const openCount = $derived(openActionableFindings(findings).length);

  async function load() {
    loading = true;
    error = null;
    try {
      const [allRuns, projs, tix] = await Promise.all([
        fetchAuditRuns(),
        fetchProjects(),
        fetchTickets(),
      ]);
      runs = allRuns;
      projects = projs;
      tickets = tix;
      reportRun = pickReportRun(allRuns);
      findings = reportRun ? (await fetchRunFindings(reportRun.id)).findings : [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<section class="report">
  <header class="report-head">
    <div>
      <h1 class="report-title">Ticket Audit</h1>
      <p class="report-sub">
        Advisory findings from the weekly backlog audit. Read-only here — Accept / Reject lands
        with PD-287.
      </p>
    </div>
    <a class="report-board-link" href="/task-monitor">← Task Monitor</a>
  </header>

  {#if loading}
    <p class="report-muted">Loading…</p>
  {:else if error}
    <p class="report-error" role="alert">{error}</p>
  {:else if !reportRun}
    <p class="report-muted">
      No completed audit runs yet.
      {#if isRunInFlight(newest)}A run is currently {runStatusLabel(newest!.status).toLowerCase()}.{/if}
    </p>
  {:else}
    <div class="report-meta">
      <span class="run-status" style="--rc: {runStatusColor(reportRun.status)}">
        {runStatusLabel(reportRun.status)}
      </span>
      <span>
        Showing <strong>{openCount}</strong> open finding{openCount === 1 ? '' : 's'} from
        <a href="/task-monitor/reports/ticket-audit/{reportRun.id}">run #{reportRun.id}</a>
        · finished {formatTs(reportRun.finishedAt)}
      </span>
      {#if runningNewer}
        <span class="run-fresher">A newer run is {runStatusLabel(newest!.status).toLowerCase()}…</span>
      {/if}
    </div>

    <AuditReport {findings} {projects} {tickets} mode="open" />
  {/if}

  {#if !loading && !error && runs.length > 0}
    <section class="run-history">
      <h2 class="run-history-title">Recent runs</h2>
      <ul class="run-history-list">
        {#each runs.slice(0, HISTORY_LIMIT) as r (r.id)}
          <li class="run-history-row">
            <a href="/task-monitor/reports/ticket-audit/{r.id}">run #{r.id}</a>
            <span class="hist-status" style="--rc: {runStatusColor(r.status)}">{runStatusLabel(r.status)}</span>
            <span class="hist-counts">{#if r.counts}{r.counts.findings} findings{:else}—{/if}</span>
            <span class="hist-time">{formatTs(r.finishedAt ?? r.createdAt)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
