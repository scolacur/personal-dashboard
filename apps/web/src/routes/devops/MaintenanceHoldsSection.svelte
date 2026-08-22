<script lang="ts">
  import { onMount } from 'svelte';
  import type { MaintenanceHold } from '@dashboard/shared';
  import { formatTs } from '$lib/audit-display';
  import {
    durationLabel,
    holdDurationMs,
    holdExplainer,
    holdStatusLabel,
  } from '$lib/maintenance-display';
  import { fetchHolds, fetchMaintenanceStatus, startMaintenanceHold, type MaintenanceStatus } from '$lib/maintenance-api';
  import MaintenanceJobRow from './MaintenanceJobRow.svelte';

  // Maintenance Hold Jobs (PD-498) — a peer of Recurring Jobs, not a member of it.
  //
  // These jobs have no cron. What schedules them is the maintenance HOLD, so the section explains
  // the hold, offers a button to open one, logs the holds that have happened, and nests the jobs
  // that run inside them.

  const POLL_MS = 5000;

  let status = $state<MaintenanceStatus | null>(null);
  let holds = $state<MaintenanceHold[]>([]);
  let loading = $state(true);
  let starting = $state(false);
  let notice = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function refresh() {
    try {
      [status, holds] = await Promise.all([fetchMaintenanceStatus(), fetchHolds(10)]);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  });

  async function startHold() {
    if (starting) return;
    starting = true;
    notice = null;
    try {
      const result = await startMaintenanceHold();
      // The button can't promise a hold: if Robots are working it queues one instead. Say which
      // happened rather than showing a spinner that resolves into nothing visible.
      notice = result.joined
        ? 'A maintenance hold is already open.'
        : result.immediate
          ? 'Maintenance hold started.'
          : 'Queued — the hold will open as soon as the running Robots finish.';
      await refresh();
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
    }
  }
</script>

<section class="maintenance-section" id="maintenance-holds">
  <div class="section-head">
    <h2 class="section-title">Maintenance Hold Jobs</h2>
    {#if status?.active}
      <span class="hold-pill hold-pill--active">Hold active</span>
    {:else if status?.queued}
      <span class="hold-pill hold-pill--queued">Hold queued</span>
    {/if}
  </div>

  <p class="section-sub">{holdExplainer()}</p>

  <div class="section-actions">
    <button class="start-hold" type="button" disabled={starting} onclick={startHold}>
      {starting ? 'Starting…' : 'Start maintenance hold'}
    </button>
    {#if notice}<span class="hold-notice">{notice}</span>{/if}
  </div>

  {#if error}
    <p class="hold-error">Couldn’t read maintenance status: {error}</p>
  {/if}

  {#if status}
    <ul class="maintenance-job-list">
      {#each status.jobs as job (job.jobName)}
        <MaintenanceJobRow {job} activeHold={status.active} onRan={refresh} />
      {/each}
    </ul>
  {/if}

  <h3 class="hold-log-title">Recent holds</h3>
  {#if loading}
    <p class="hold-log-empty">Loading…</p>
  {:else if holds.length === 0}
    <p class="hold-log-empty">No maintenance holds yet.</p>
  {:else}
    <ul class="hold-log">
      {#each holds as hold (hold.id)}
        {@const held = holdDurationMs(hold)}
        <li class="hold-entry hold-entry--{hold.status}">
          <div class="hold-entry-head">
            <span class="hold-when">{formatTs(hold.startedAt ?? hold.requestedAt)}</span>
            <span class="hold-trigger">{hold.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span>
            <span class="hold-status">{holdStatusLabel(hold)}</span>
            {#if held !== null}<span class="hold-duration">held {durationLabel(held)}</span>{/if}
          </div>
          {#if hold.note}<p class="hold-note">{hold.note}</p>{/if}
          {#if hold.runs.length > 0}
            <ul class="hold-runs">
              {#each hold.runs as run (run.jobRunId)}
                <li>
                  <a href="/devops/jobs/{encodeURIComponent(run.jobName)}/{run.jobRunId}">
                    {run.jobName}
                  </a>
                  <span class="hold-run-status">{run.status}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="hold-runs-empty">No jobs ran in this hold.</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style lang="scss" src="./MaintenanceHoldsSection.scss"></style>
