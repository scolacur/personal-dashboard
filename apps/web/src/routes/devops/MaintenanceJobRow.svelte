<script lang="ts">
  import { Info } from 'lucide-svelte';
  import type { MaintenanceHold, MaintenanceJob } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import JobRunsList from '$lib/JobRunsList.svelte';
  import type { RecurringJob } from '$lib/jobs';
  import { runNowDisabledReason } from '$lib/maintenance-display';
  import { runMaintenanceJob } from '$lib/maintenance-api';

  // One maintenance job, nested inside the Maintenance Hold Jobs section (PD-498).
  //
  // Deliberately NOT a RecurringJob row: it has no cron. "Runs: during every maintenance hold" is
  // the whole schedule, and showing a next-fire time computed from a cron expression it does not
  // have would be a fiction. It reuses JobRunsList, though — the run history and detail page come
  // free from declaring a job_runs name (PD-442).
  let {
    job,
    activeHold,
    onRan,
  }: { job: MaintenanceJob; activeHold: MaintenanceHold | null; onRan?: () => void } = $props();

  let infoOpen = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const disabledReason = $derived(runNowDisabledReason(activeHold));

  // JobRunsList takes the registry shape; a maintenance job is schedule-less, so this adapts it
  // rather than adding a maintenance branch inside that component.
  const asRecurring = $derived<RecurringJob>({
    id: job.jobName,
    name: job.name,
    description: job.description,
    schedule: '',
    kind: 'generic',
    runs: { jobName: job.jobName, limit: 5 },
  });

  async function runNow() {
    if (disabledReason || busy) return;
    busy = true;
    error = null;
    try {
      await runMaintenanceJob(job.jobName);
      onRan?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<li class="maintenance-job">
  <div class="job-header">
    <span class="job-name">{job.name}</span>
    <button class="job-info" type="button" aria-label="About {job.name}" onclick={() => (infoOpen = true)}>
      <Info size={15} />
    </button>
  </div>

  <div class="job-controls">
    <span class="job-schedule">Runs: during every maintenance hold</span>
    <!-- title= carries the reason so the disabled state and its explanation cannot disagree; a
         disabled <button> gets no tooltip in some browsers, hence the wrapper. -->
    <span class="run-now-wrap" title={disabledReason ?? 'Run this job inside the open hold'}>
      <button
        class="run-now"
        type="button"
        disabled={disabledReason !== null || busy}
        aria-describedby={disabledReason ? `${job.jobName}-why` : undefined}
        onclick={runNow}
      >
        {busy ? 'Starting…' : 'Run now'}
      </button>
    </span>
  </div>

  {#if disabledReason}
    <p class="run-now-why" id="{job.jobName}-why">{disabledReason}</p>
  {/if}
  {#if error}
    <p class="run-now-error">{error}</p>
  {/if}

  <JobRunsList job={asRecurring} emptyText="No runs yet — this job has never run in a hold." />

  <Modal open={infoOpen} title={job.name} onClose={() => (infoOpen = false)}>
    <p class="job-about">{job.description}</p>
  </Modal>
</li>

<style lang="scss" src="./MaintenanceJobRow.scss"></style>
