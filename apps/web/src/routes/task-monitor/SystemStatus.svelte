<script lang="ts">
  import type { AgentState, SystemStatus, WorkerHeartbeat } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import { formatRelativeTime } from '../deploy-status-utils';

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

  function isStale(w: WorkerHeartbeat): boolean {
    return now - w.lastSeen > STALE_MS;
  }
</script>

{#if status}
  <div class="system-status">
    <div class="ss-line">
      <span class="ss-label">Sortie</span>
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
        <span class="ss-label">Robot</span>
        <span class="ss-dispatch" class:paused={dispatch.paused}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{dispatch.paused ? 'dispatch paused' : 'dispatch running'}</span>
        </span>
      </div>
      {#if dispatch.paused}
        <div class="ss-fault" role="status">
          <strong>⛔ Robot dispatch paused</strong>
          <span class="reason">{dispatch.reason ?? 'system-wide fault'}</span>
          {#if dispatch.since}<span class="since">since {formatRelativeTime(dispatch.since, now)}</span>{/if}
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
