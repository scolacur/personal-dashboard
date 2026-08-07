<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { JobRun } from '@dashboard/shared';
  import type { RecurringJob } from './jobs';
  import { fetchJobRuns } from './job-runs-api';
  import {
    defaultHeadline,
    relativeTime,
    runDetailPath,
    runDuration,
    runStatusColor,
    runStatusLabel,
  } from './job-runs-display';

  // Recent runs of one job, read from the shared job_runs store (PD-442). A job gets this by
  // declaring `runs` in the registry — there is no per-job run table and no per-job component.
  //
  // The `headline` snippet is the whole reason this can be generic: the component renders when a
  // run happened, whether it worked and how long it took, and hands the summary payload back to
  // the caller to say what it *found*. This file must never learn what a scan match is.
  let {
    job,
    limit,
    viewAllHref,
    headline,
    emptyText = 'No runs yet.',
  }: {
    job: RecurringJob;
    /** Overrides the job's registered `runs.limit`. */
    limit?: number;
    /** Shown when there are more runs than are displayed. */
    viewAllHref?: string;
    headline?: Snippet<[JobRun]>;
    emptyText?: string;
  } = $props();

  const POLL_MS = 5000;

  const jobName = $derived(job.runs?.jobName ?? null);
  const shownLimit = $derived(limit ?? job.runs?.limit ?? 5);

  let runs = $state<JobRun[]>([]);
  let loading = $state(true);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Poll only while something is actually in flight, then stop — the same discipline AuditJobRow
  // uses. A run list that polls forever costs a request every five seconds for a job that fires
  // weekly.
  const inFlight = $derived(runs.some((r) => r.status === 'running'));

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function syncPolling(): void {
    if (inFlight && pollTimer === null) pollTimer = setInterval(refresh, POLL_MS);
    else if (!inFlight && pollTimer !== null) stopPolling();
  }

  async function refresh(): Promise<void> {
    if (!jobName) {
      loading = false;
      return;
    }
    try {
      // One extra so "there are more" is a fact rather than a guess.
      runs = await fetchJobRuns(jobName, shownLimit + 1);
    } catch {
      // Keep the last known runs. Run history is observability, not a critical path — a failed
      // fetch should not blank the surface the user is reading.
    } finally {
      loading = false;
      syncPolling();
    }
  }

  const shown = $derived(runs.slice(0, shownLimit));
  const hasMore = $derived(runs.length > shownLimit);

  onMount(() => {
    refresh();
    return stopPolling;
  });
</script>

{#if job.runs}
  <div class="job-runs">
    {#if loading}
      <p class="job-runs-muted">Loading runs…</p>
    {:else if shown.length === 0}
      <p class="job-runs-muted">{emptyText}</p>
    {:else}
      <ul class="job-runs-list">
        {#each shown as run (run.id)}
          {@const href = runDetailPath(job, run.id)}
          {@const duration = runDuration(run)}
          <li class="job-run" class:job-run-error={run.status === 'error'}>
            <span
              class="job-run-status"
              style="--rc: {runStatusColor(run.status)}"
              title={runStatusLabel(run.status)}
            >
              {runStatusLabel(run.status)}
            </span>

            <span class="job-run-when" title={new Date(run.startedAt).toLocaleString()}>
              {relativeTime(run.startedAt)}
            </span>

            <span class="job-run-duration">{duration ?? '—'}</span>

            <span class="job-run-headline">
              {#if headline}{@render headline(run)}{:else}{defaultHeadline(run)}{/if}
            </span>

            {#if href}
              <a class="job-run-link" {href}>Details</a>
            {/if}
          </li>
        {/each}
      </ul>

      {#if hasMore && viewAllHref}
        <a class="job-runs-view-all" href={viewAllHref}>View all runs</a>
      {/if}
    {/if}
  </div>
{/if}

<style lang="scss" src="./JobRunsList.scss"></style>
