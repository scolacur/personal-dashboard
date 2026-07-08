<script lang="ts">
  import { RECURRING_JOBS } from '$lib/jobs';
  import AuditJobRow from './AuditJobRow.svelte';
  import JobRow from './JobRow.svelte';

  // The Recurring Jobs list (PD-286). On the Task Monitor page it's capped with a "View all"
  // link to the full /task-monitor/jobs page; the full page renders it uncapped.
  let {
    heading = 'Jobs',
    limit,
    viewAllHref,
  }: { heading?: string; limit?: number; viewAllHref?: string } = $props();

  const shown = $derived(limit != null ? RECURRING_JOBS.slice(0, limit) : RECURRING_JOBS);
  const hasMore = $derived(limit != null && RECURRING_JOBS.length > limit);
</script>

<section class="jobs-section" id="jobs">
  <div class="section-head">
    <h2 class="section-title">{heading}</h2>
    {#if viewAllHref && hasMore}
      <a class="jobs-view-all" href={viewAllHref}>View all ({RECURRING_JOBS.length})</a>
    {/if}
  </div>

  <ul class="job-list">
    {#each shown as job (job.id)}
      {#if job.kind === 'audit'}
        <AuditJobRow {job} />
      {:else}
        <JobRow {job} />
      {/if}
    {/each}
  </ul>
</section>

<style lang="scss" src="./JobsList.scss"></style>
