<script lang="ts">
  import type { AgentState, SystemStatus, WorkerHeartbeat } from '@dashboard/shared';
  import { AGENT_STATE_LABELS, rateLimitHealth } from '@dashboard/shared';
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

  // PD-463: spend against the loop-wide ceiling. Null until a worker publishes a policy — better a
  // missing row than a ceiling shown to a user that nothing is actually enforcing.
  let budget = $derived(status?.budget ?? null);

  // PD-248: GitHub API headroom. `stale` is its own state, not a flavour of healthy — a probe that
  // stopped running tells you nothing about now, and a comfortable number from an hour ago is worse
  // than no number at all. Nothing is rendered when there has never been a probe.
  let rateLimit = $derived(status?.githubRateLimit ?? null);
  let rateHealth = $derived(rateLimitHealth(rateLimit, now));
  const WARN_FRACTION = 0.8;

  /** One limb of the ceiling, or null when that limb is disabled. */
  function limb(used: number, limit: number | null, unit: string) {
    if (limit === null || limit <= 0) return null;
    const fraction = used / limit;
    return {
      label: `${used.toLocaleString()} / ${limit.toLocaleString()} ${unit}`,
      near: fraction >= WARN_FRACTION,
      over: used >= limit,
    };
  }

  let budgetLimbs = $derived(
    budget
      ? [limb(budget.turnsUsed, budget.turnsLimit, 'turns'), limb(budget.tokensUsed, budget.tokensLimit, 'tokens')].filter(
          (l) => l !== null,
        )
      : [],
  );

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
          <!-- PD-248: name WHICH hold. Both end by themselves, but a spent Anthropic quota is
               purely a wait, while GitHub throttling the loop is worth looking into — so the copy
               must not say "session limit" when it is the other one. -->
          {#if sessionLimit.kind === 'github-rate-limit'}
            <strong>⏳ Waiting out a GitHub rate limit</strong>
          {:else}
            <strong>⏳ Waiting out the session limit</strong>
          {/if}
          <span class="until">resumes {formatClockTime(sessionLimit.until)}</span>
          {#if sessionLimit.reason}<span class="reason">{sessionLimit.reason}</span>{/if}
          <span class="note">No action needed — dispatch resumes on its own.</span>
        </div>
      {/if}
    {/if}

    <!-- PD-248: GitHub API headroom, so throttling is visible BEFORE it stops a run rather than
         being inferred from server logs afterwards. Distinct from an auth fault above: a throttle
         holds dispatch and clears itself, a bad credential pauses it until a human acts. -->
    {#if rateLimit}
      <div class="ss-line">
        <span class="ss-label">GitHub API</span>
        <span class="ss-rate" class:low={rateHealth === 'low'} class:over={rateHealth === 'exhausted'} class:stale={rateHealth === 'stale'}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">
            {#if rateHealth === 'stale'}
              headroom unknown
            {:else}
              {rateLimit.core.remaining.toLocaleString()} / {rateLimit.core.limit.toLocaleString()} left
            {/if}
          </span>
        </span>
        {#if rateHealth === 'stale'}
          <span class="ss-window">probe last ran {formatRelativeTime(rateLimit.checkedAt, now)}</span>
        {:else}
          <span class="ss-window">resets {formatClockTime(rateLimit.core.resetAt)}</span>
        {/if}
      </div>
    {/if}

    <!-- PD-463: consumption against the ceiling, so "why did the loop pause?" is answerable without
         reading the DB — and so the approach to the ceiling is visible BEFORE it bites. -->
    {#if budgetLimbs.length > 0 && budget}
      <div class="ss-line">
        <span class="ss-label">Budget</span>
        {#each budgetLimbs as l (l.label)}
          <span class="ss-budget" class:near={l.near} class:over={l.over}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{l.label}</span>
          </span>
        {/each}
        <span class="ss-window">per {Math.round(budget.windowMs / 3_600_000)}h</span>
      </div>
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
