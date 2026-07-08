<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import type { AgentProject, AgentTicket, AuditFinding, AuditRun } from '@dashboard/shared';
  import { fetchRunFindings } from '$lib/audit-api';
  import { runStatusLabel, runStatusColor, formatTs } from '$lib/audit-display';
  import { fetchProjects, fetchTickets } from '../../../api';
  import AuditReport from '../AuditReport.svelte';

  const runId = $derived(Number($page.params.runId));

  let loading = $state(true);
  let error = $state<string | null>(null);
  let run = $state<AuditRun | null>(null);
  let findings = $state<AuditFinding[]>([]);
  let projects = $state<AgentProject[]>([]);
  let tickets = $state<AgentTicket[]>([]);

  async function load() {
    loading = true;
    error = null;
    try {
      const [rf, projs, tix] = await Promise.all([
        fetchRunFindings(runId),
        fetchProjects(),
        fetchTickets(),
      ]);
      run = rf.run;
      findings = rf.findings;
      projects = projs;
      tickets = tix;
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
      <h1 class="report-title">Audit run #{Number.isNaN(runId) ? '?' : runId}</h1>
      <p class="report-sub">A read-only snapshot of every finding this run produced.</p>
    </div>
    <a class="report-board-link" href="/task-monitor/reports/ticket-audit">← All findings</a>
  </header>

  {#if loading}
    <p class="report-muted">Loading…</p>
  {:else if error}
    <p class="report-error" role="alert">{error}</p>
  {:else if run}
    <div class="report-meta">
      <span class="run-status" style="--rc: {runStatusColor(run.status)}">
        {runStatusLabel(run.status)}
      </span>
      <span>
        {run.scope ? `${run.scope} · ` : ''}{findings.length} finding{findings.length === 1
          ? ''
          : 's'}
        · started {formatTs(run.startedAt)} · finished {formatTs(run.finishedAt)}
        {#if run.model}· {run.model}{/if}
      </span>
    </div>

    <AuditReport {findings} {projects} {tickets} mode="all" />
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
