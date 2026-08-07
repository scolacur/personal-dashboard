<script lang="ts">
  import type { JobRun, BstScanRunSummary, BstDraftsRunSummary } from '@dashboard/shared';
  import { BST_SCAN_JOB, BST_DRAFTS_JOB } from '@dashboard/shared';
  import Collapsible from '$lib/Collapsible.svelte';
  import JobRunsList from '$lib/JobRunsList.svelte';
  import { defaultHeadline } from '$lib/job-runs-display';
  import { RECURRING_JOBS } from '$lib/jobs';

  // Run history for the widget's two jobs (PD-440), rendered by the generic JobRunsList (PD-442)
  // rather than a bespoke run table. Both jobs run unattended, so silence here is ambiguous
  // between "nothing was found" and "nothing ran" — which is the whole reason this section exists.
  //
  // The scan's *loud* status (failed / partial / stale, with the per-thread breakdown) stays in
  // ScanStatus above. This is the flatter question: did each job run, when, and what came out.

  const scanJob = RECURRING_JOBS.find((j) => j.runs?.jobName === BST_SCAN_JOB);
  const draftsJob = RECURRING_JOBS.find((j) => j.runs?.jobName === BST_DRAFTS_JOB);

  /** A run that did not end cleanly explains itself instead of showing the half that worked —
   *  otherwise a partial scan reads as a thin week, which is the confusion PD-471 designed
   *  against. `defaultHeadline` already leads with the reason for every non-ok status. */
  function isClean(run: JobRun): boolean {
    return run.status === 'ok';
  }
</script>

<Collapsible title="Runs" storeKey="bst-runs">
  <div class="bst-runs">
    {#if scanJob}
      <section class="bst-runs-job">
        <h3 class="bst-runs-title">r/modular scan</h3>
        <JobRunsList job={scanJob} limit={5} emptyText="The scan has never run.">
          {#snippet headline(run: JobRun)}
            {#if isClean(run)}
              {@const s = run.summary as BstScanRunSummary | null}
              {#if s}
                {s.scanned} comment{s.scanned === 1 ? '' : 's'} across {s.threads} thread{s.threads ===
                1
                  ? ''
                  : 's'} · {s.created} new match{s.created === 1 ? '' : 'es'}
              {:else}
                Ran, but recorded no numbers
              {/if}
            {:else}
              {defaultHeadline(run)}
            {/if}
          {/snippet}
        </JobRunsList>
      </section>
    {/if}

    {#if draftsJob}
      <section class="bst-runs-job">
        <h3 class="bst-runs-title">Monthly post drafter</h3>
        <JobRunsList job={draftsJob} limit={5} emptyText="The drafter has never run on a schedule.">
          {#snippet headline(run: JobRun)}
            {#if isClean(run)}
              {@const s = run.summary as BstDraftsRunSummary | null}
              {#if s}
                {s.drafts} draft{s.drafts === 1 ? '' : 's'} generated{s.formats
                  ? ` · ${s.formats}`
                  : ''}
              {:else}
                Ran, but recorded no numbers
              {/if}
            {:else}
              {defaultHeadline(run)}
            {/if}
          {/snippet}
        </JobRunsList>
      </section>
    {/if}
  </div>
</Collapsible>

<style lang="scss" src="./RunsPanel.scss"></style>
