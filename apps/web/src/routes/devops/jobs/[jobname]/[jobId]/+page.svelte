<script lang="ts">
  import { page } from '$app/stores';
  import type { JobRun } from '@dashboard/shared';
  import { fetchJobRun } from '$lib/job-runs-api';
  import { RECURRING_JOBS } from '$lib/jobs';
  import {
    formatTs,
    humanizeKey,
    relativeTime,
    runDuration,
    runStatusColor,
    runStatusLabel,
  } from '$lib/job-runs-display';

  // One run of one job (PD-442) — the generic detail page every registered job gets for free.
  // A job wanting a richer report registers its own `runs.detailHref` and is never linked here;
  // that is how the Ticket Audit keeps its findings report once it moves onto the shared store.

  const jobName = $derived($page.params.jobname ?? '');
  const runId = $derived(Number($page.params.jobId));

  // The registry gives the job a human name; a run for a job that isn't registered still renders,
  // because the run record is the truth and the registry is only decoration here.
  const job = $derived(RECURRING_JOBS.find((j) => j.runs?.jobName === jobName) ?? null);
  const heading = $derived(job?.name ?? jobName);

  let loading = $state(true);
  let error = $state<string | null>(null);
  let run = $state<JobRun | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    run = null;

    if (!Number.isInteger(runId)) {
      error = 'That run id is not a number.';
      loading = false;
      return;
    }

    try {
      run = await fetchJobRun(jobName, runId);
    } catch (e) {
      // The server 404s both for an unknown id and for a run belonging to another job. Say the
      // useful thing rather than echoing "404 Not Found".
      const msg = e instanceof Error ? e.message : String(e);
      error = msg.startsWith('404')
        ? `No run #${runId} for “${jobName}”.`
        : `Couldn't load this run: ${msg}`;
    } finally {
      loading = false;
    }
  }

  // Keyed on the route params, so navigating straight from one run to another re-fetches rather
  // than leaving the previous run on screen. This covers the initial load too — no onMount.
  $effect(() => {
    void jobName;
    void runId;
    load();
  });

  /** Scalar summary entries render as a definition list; anything nested falls to the raw JSON
   *  block below, which is the honest place for a payload this page cannot know the shape of. */
  const scalarSummary = $derived(
    Object.entries(run?.summary ?? {}).filter(
      ([, v]) => v === null || ['number', 'string', 'boolean'].includes(typeof v),
    ),
  );

  const hasNestedSummary = $derived(
    Object.entries(run?.summary ?? {}).length > scalarSummary.length,
  );
</script>

<section class="job-run-detail">
  <header class="jrd-head">
    <div>
      <h1 class="jrd-title">{heading} — run #{Number.isNaN(runId) ? '?' : runId}</h1>
      <p class="jrd-sub">A read-only record of one execution of this job.</p>
    </div>
    <a class="jrd-back" href="/devops/jobs">← Recurring Jobs</a>
  </header>

  {#if loading}
    <p class="jrd-muted">Loading…</p>
  {:else if error}
    <p class="jrd-error" role="alert">{error}</p>
  {:else if run}
    <div class="jrd-meta">
      <span class="jrd-status" style="--rc: {runStatusColor(run.status)}">
        {runStatusLabel(run.status)}
      </span>
      <span>
        started {formatTs(run.startedAt)} ({relativeTime(run.startedAt)})
        · finished {formatTs(run.finishedAt)}
        · took {runDuration(run) ?? '—'}
      </span>
    </div>

    {#if run.error}
      <div class="jrd-failure" role="alert">
        <span class="jrd-failure-label">Failure</span>
        <span class="jrd-failure-reason">{run.error}</span>
      </div>
    {/if}

    <h2 class="jrd-section-title">Summary</h2>
    {#if scalarSummary.length > 0}
      <dl class="jrd-summary">
        {#each scalarSummary as [key, value] (key)}
          <dt>{humanizeKey(key)}</dt>
          <dd>{value === null ? '—' : String(value)}</dd>
        {/each}
      </dl>
    {:else if !run.summary}
      <p class="jrd-muted">This run recorded no summary.</p>
    {/if}

    {#if hasNestedSummary}
      <details class="jrd-raw">
        <summary>Full payload</summary>
        <pre>{JSON.stringify(run.summary, null, 2)}</pre>
      </details>
    {/if}
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
