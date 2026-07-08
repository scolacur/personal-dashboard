<script lang="ts">
  import { onMount } from 'svelte';
  import { Info } from 'lucide-svelte';
  import type { AuditRun } from '@dashboard/shared';
  import type { RecurringJob } from '$lib/jobs';
  import { fetchAuditRuns, requestAuditRun } from '$lib/audit-api';
  import { latestRun, isRunInFlight } from '$lib/audit-logic';
  import { formatTs } from '$lib/audit-display';
  import { nextCronRun, scheduleLabel } from '$lib/cron';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';
  import RunStatusIndicator from './RunStatusIndicator.svelte';

  // The rich Recurring-Jobs row for the Ticket Audit (PD-286): schedule + next run, the latest
  // run's live status (in-progress indicator), Run now, and a report link. Polls only while a
  // run is in flight so it flips to done/error without a manual refresh, then stops.
  let { job }: { job: RecurringJob } = $props();

  const POLL_MS = 5000;
  const nextRunAt = $derived(nextCronRun(job.schedule, Date.now()));

  let runs = $state<AuditRun[]>([]);
  let loading = $state(true);
  let starting = $state(false);
  let toast = $state<string | null>(null);
  let infoOpen = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const RECENT_LIMIT = 3;
  const latest = $derived(latestRun(runs));
  const inFlight = $derived(isRunInFlight(latest));
  // Runs arrive newest-first from the API; show the most recent few as rows.
  const recentRuns = $derived(runs.slice(0, RECENT_LIMIT));
  const permalink = (id: number) => `${job.reportRoute}/${id}`;

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function syncPolling() {
    if (inFlight && pollTimer === null) {
      pollTimer = setInterval(refresh, POLL_MS);
    } else if (!inFlight && pollTimer !== null) {
      stopPolling();
    }
  }

  async function refresh() {
    try {
      runs = await fetchAuditRuns();
    } catch {
      // keep the last known runs
    } finally {
      loading = false;
      syncPolling();
    }
  }

  async function runNow() {
    if (inFlight || starting) return;
    starting = true;
    try {
      const { created } = await requestAuditRun();
      toast = created ? 'Audit run queued.' : 'A run is already in flight.';
      await refresh();
    } catch (e) {
      toast = `Couldn't start a run: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      starting = false;
      setTimeout(() => (toast = null), 4000);
    }
  }

  onMount(() => {
    refresh();
    return stopPolling;
  });
</script>

<li class="job-row">
  <div class="job-header">
    <span class="job-name">{job.name}</span>
    <button class="job-info" type="button" aria-label="About {job.name}" onclick={() => (infoOpen = true)}>
      <Info size={15} />
    </button>
  </div>

  <div class="job-controls">
    <div class="job-schedule">
      <span>Frequency: {scheduleLabel(job.schedule)}</span>
      {#if nextRunAt}<span class="job-nextrun">Next run: {formatTs(nextRunAt)}</span>{/if}
    </div>
    <Button variant="primary" onclick={runNow} disabled={inFlight || starting}>
      {#if inFlight}Running…{:else if starting}Starting…{:else}Run now{/if}
    </Button>
  </div>

  {#if loading}
    <p class="run-empty">Loading runs…</p>
  {:else if recentRuns.length === 0}
    <p class="run-empty">No runs yet.</p>
  {:else}
    <ul class="run-rows">
      {#each recentRuns as r (r.id)}
        <li class="run-row">
          <RunStatusIndicator status={r.status} />
          <span class="run-id">run #{r.id}</span>
          <span class="run-count">
            {#if r.counts}{r.counts.findings} finding{r.counts.findings === 1 ? '' : 's'}{:else}—{/if}
          </span>
          <span class="run-time">{formatTs(r.finishedAt ?? r.createdAt)}</span>
          {#if r.status === 'done' || r.status === 'error'}
            <a class="run-report" href={permalink(r.id)}>View report</a>
          {:else}
            <span class="run-report run-report-muted">in progress…</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if toast}
    <div class="toast" role="status">{toast}</div>
  {/if}

  <Modal open={infoOpen} title={job.name} onClose={() => (infoOpen = false)}>
    <p class="job-about">{job.description}</p>
  </Modal>
</li>

<style lang="scss" src="./AuditJobRow.scss"></style>
