<script lang="ts">
  import type { AgentState, SystemStatus, WorkerHeartbeat } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import { formatRelativeTime } from '../deploy-status-utils';
  import { pauseDispatch, resumeDispatch } from './api';

  // In-flight states worth a live glance (terminal done/wontfix are excluded — the fleet
  // view is about active work). Fixed order so chips don't reshuffle between polls.
  const ACTIVE_STATES: AgentState[] = [
    'working',
    'queued',
    'in-review',
    'awaiting-human',
    'needs-human',
    'stuck',
  ];

  // A worker with no heartbeat for >3× its write interval (30s) is treated as down.
  const STALE_MS = 90_000;
  const REFRESH_MS = 30_000;

  let status = $state<SystemStatus | null>(null);
  let now = $state(Date.now());

  function load(): void {
    fetch('/api/widgets/task-monitor/system-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SystemStatus | null) => {
        status = data;
      })
      .catch(() => {});
  }

  $effect(() => {
    load();
    const timer = setInterval(() => {
      now = Date.now();
      load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  let activeStates = $derived(
    status ? ACTIVE_STATES.filter((s) => (status!.sortie[s] ?? 0) > 0) : [],
  );

  let dispatch = $derived(status?.dispatch ?? null);
  // PD-470: present only while the loop is waiting out a provider session limit. Re-checked against
  // the local clock as well as the server's, so the banner disappears at the reset even if a poll
  // is in flight.
  let sessionLimit = $derived(
    status?.sessionLimit && status.sessionLimit.until > now ? status.sessionLimit : null,
  );

  /** Wall-clock "5:30 AM" for the reset — a relative "in 3h" reads as an estimate, and the whole
   *  point is that the provider named a specific time. */
  function formatClockTime(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function isStale(w: WorkerHeartbeat): boolean {
    return now - w.lastSeen > STALE_MS;
  }

  // C4 remediation: pause/resume Robot dispatch loop-wide, straight from Site Status.
  let toggling = $state(false);
  async function toggleDispatch(): Promise<void> {
    if (toggling || !dispatch) return;
    toggling = true;
    try {
      const next = dispatch.paused ? await resumeDispatch() : await pauseDispatch();
      if (status) status = { ...status, dispatch: next };
    } catch {
      // leave the current state; the next poll reconciles
    } finally {
      toggling = false;
    }
  }
</script>

{#if status}
  <div class="system-status">
    <div class="ss-line">
      <span class="ss-label">Robot</span>
      {#if activeStates.length === 0}
        <span class="ss-idle">idle</span>
      {:else}
        {#each activeStates as s (s)}
          <span class="ss-chip agent-state-{s}">
            <span class="dot" aria-hidden="true"></span>
            <span class="count">{status.sortie[s]}</span>
            <span class="name">{AGENT_STATE_LABELS[s]}</span>
          </span>
        {/each}
      {/if}
    </div>

    {#if dispatch}
      <div class="ss-line">
        <span class="ss-label">Dispatch</span>
        <span class="ss-dispatch" class:paused={dispatch.paused}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{dispatch.paused ? 'dispatch paused' : 'dispatch running'}</span>
        </span>
        <button class="ss-toggle" type="button" onclick={toggleDispatch} disabled={toggling}>
          {toggling ? '…' : dispatch.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {#if dispatch.paused}
        <div class="ss-fault" role="status">
          <strong>⛔ Robot dispatch paused</strong>
          <span class="reason">{dispatch.reason ?? 'system-wide fault'}</span>
          {#if dispatch.since}<span class="since">since {formatRelativeTime(dispatch.since, now)}</span>{/if}
        </div>
      {/if}
      <!-- PD-470: deliberately NOT styled as a fault. A session-limit hold needs no action — it
           ends by itself at the stated time — so it reads as "waiting until X", and the copy says
           so outright. The API reports an expired hold as none, so this can't linger. -->
      {#if sessionLimit}
        <div class="ss-holding" role="status">
          <strong>⏳ Waiting out the session limit</strong>
          <span class="until">resumes {formatClockTime(sessionLimit.until)}</span>
          {#if sessionLimit.reason}<span class="reason">{sessionLimit.reason}</span>{/if}
          <span class="note">No action needed — dispatch resumes on its own.</span>
        </div>
      {/if}
    {/if}

    <div class="ss-line">
      <span class="ss-label">Workers</span>
      {#if status.workers.length === 0}
        <span class="ss-idle">no heartbeat</span>
      {:else}
        {#each status.workers as w (w.worker)}
          <span class="ss-worker" class:stale={isStale(w)}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{w.worker}</span>
            <span class="meta">
              {isStale(w) ? 'stale' : 'alive'} · {formatRelativeTime(w.lastSeen, now)}
            </span>
            {#if w.sha}<span class="sha">{w.sha}</span>{/if}
          </span>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style lang="scss" src="./SystemStatus.scss"></style>
