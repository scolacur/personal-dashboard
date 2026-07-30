<script lang="ts">
  import { Info } from 'lucide-svelte';
  import type { RecurringJob } from '$lib/jobs';
  import { nextCronRun, scheduleLabel } from '$lib/cron';
  import { formatTs } from '$lib/audit-display';
  import Modal from '$lib/Modal.svelte';

  // Schedule-only Recurring-Jobs row (PD-286) for jobs without a run engine (e.g. the nightly
  // DB backup). Shows the cadence + next fire time computed from the cron. Real run history for
  // the backup is tracked by PD-317.
  let { job }: { job: RecurringJob } = $props();

  const nextRunAt = $derived(nextCronRun(job.schedule, Date.now()));
  let infoOpen = $state(false);
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
  </div>

  <Modal open={infoOpen} title={job.name} onClose={() => (infoOpen = false)}>
    <p class="job-about">{job.description}</p>
  </Modal>
</li>

<style lang="scss" src="./JobRow.scss"></style>
