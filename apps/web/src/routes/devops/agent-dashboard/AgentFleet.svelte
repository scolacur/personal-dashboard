<script lang="ts">
  // The Agent Dashboard's own rendering of /system-status (PD-818), plus the live robot tiles
  // (PD-819, Epic PD-682). Page-only: the compact /devops "Agent" card keeps rendering
  // SystemStatus.svelte unchanged — the two share their helpers via ../system-status-view.
  import type { SystemStatus, WorkerHeartbeat } from '@dashboard/shared';
  import { AGENT_STATE_LABELS, rateLimitHealth, workerVersionState } from '@dashboard/shared';
  import { formatRelativeTime } from '../../deploy-status-utils';
  import { pauseDispatch, resumeDispatch } from '../api';
  import {
    REFRESH_MS,
    STALE_MS,
    SYSTEM_STATUS_URL,
    activeStatesOf,
    budgetLimbsOf,
    formatClockTime,
  } from '../system-status-view';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentTile from './AgentTile.svelte';
  import {
    AVATAR_LABELS,
    DEFAULT_AVATAR,
    DEFAULT_BOT_COLOR,
    KIND_LABELS,
    MINIMAL_STYLES,
    PIXEL_STYLES,
    agentKey,
    groupByKind,
    type AvatarStyle,
  } from './agent-fleet';

  // PD-819: TEMPORARY avatar comparison — ephemeral, a reload returns to Classic. Removed once a
  // style is chosen.
  let avatar = $state<AvatarStyle>(DEFAULT_AVATAR);
  const AVATAR_FAMILIES = [
    { name: '8-bit', styles: PIXEL_STYLES },
    { name: 'Minimal', styles: MINIMAL_STYLES },
  ];

  let status = $state<SystemStatus | null>(null);
  let now = $state(Date.now());

  function load(): void {
    fetch(SYSTEM_STATUS_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SystemStatus | null) => {
        status = data;
      })
      .catch(() => {});
  }

  $effect(() => {
    load();
    const poll = setInterval(load, REFRESH_MS);
    // The elapsed clocks on the robot tiles tick between polls.
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  });

  let groups = $derived(groupByKind(status?.activeAgents ?? []));
  let activeStates = $derived(activeStatesOf(status));
  let dispatch = $derived(status?.dispatch ?? null);
  let sessionLimit = $derived(
    status?.sessionLimit && status.sessionLimit.until > now ? status.sessionLimit : null,
  );
  let budget = $derived(status?.budget ?? null);
  let budgetLimbs = $derived(budgetLimbsOf(budget));
  let rateLimit = $derived(status?.githubRateLimit ?? null);
  let rateHealth = $derived(rateLimitHealth(rateLimit, now));

  function isStale(w: WorkerHeartbeat): boolean {
    return now - w.lastSeen > STALE_MS;
  }

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

<div class="fleet">
  <div class="avatar-picker" role="radiogroup" aria-label="Avatar style (preview)">
    <span class="picker-label">Avatar preview</span>
    {#each AVATAR_FAMILIES as fam (fam.name)}
      <div class="picker-family">
        <span class="family-name">{fam.name}</span>
        {#each fam.styles as st (st)}
          <button
            type="button"
            role="radio"
            aria-checked={avatar === st}
            class:active={avatar === st}
            onclick={() => (avatar = st)}
          >
            <AgentAvatar kind="robot" style={st} color={DEFAULT_BOT_COLOR} size={26} idle={avatar !== st} />
            {AVATAR_LABELS[st]}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  {#if !status}
    <p class="loading">Loading…</p>
  {:else}
    {#if dispatch?.paused}
      <div class="callout fault" role="status">
        <strong>⛔ Robot dispatch paused</strong>
        <span>{dispatch.reason ?? 'system-wide fault'}</span>
        {#if dispatch.since}<span class="muted">since {formatRelativeTime(dispatch.since, now)}</span>{/if}
      </div>
    {/if}
    {#if sessionLimit}
      <!-- PD-791: one amber line; a self-healing wait, not a fault. -->
      <div class="callout holding" role="status">
        <strong>
          ⏳ {sessionLimit.kind === 'github-rate-limit' ? 'GitHub rate limit' : 'Provider session limit'} hit at
          {formatClockTime(sessionLimit.since)}. Dispatch will auto-resume at {formatClockTime(sessionLimit.until)}.
        </strong>
      </div>
    {/if}

    <!-- PD-819: the agents, one column per kind. -->
    <section class="fleet-section">
      <h3 class="section-label">Agents at work</h3>
      <div class="kind-columns">
        {#each groups as g (g.kind)}
          <div class="kind-column">
            <h4 class="group-label">
              {KIND_LABELS[g.kind].group}
              <span class="count" class:zero={g.agents.length === 0}>{g.agents.length}</span>
            </h4>
            {#each g.agents as a (agentKey(a))}
              <AgentTile agent={a} {avatar} {now} />
            {:else}
              <div class="column-idle">
                <AgentAvatar kind={g.kind} style={avatar} color={DEFAULT_BOT_COLOR} size={44} idle />
                <span>No {KIND_LABELS[g.kind].group.toLowerCase()} running</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </section>

    <!-- PD-818: the loop's aggregate state, as tiles. -->
    <section class="fleet-section">
      <h3 class="section-label">Loop</h3>
      <div class="tile-grid">
        {#if activeStates.length === 0}
          <div class="tile state-tile idle">
            <span class="tile-label">Tickets</span>
            <span class="tile-value">idle</span>
          </div>
        {/if}
        {#each activeStates as s (s)}
          <div class="tile state-tile agent-state-{s}" class:pulse={s === 'working'}>
            <span class="tile-label">{AGENT_STATE_LABELS[s]}</span>
            {#key status.sortie[s]}<span class="tile-value fresh">{status.sortie[s]}</span>{/key}
          </div>
        {/each}

        {#if dispatch}
          <div class="tile" class:bad={dispatch.paused}>
            <span class="tile-label">Dispatch</span>
            <span class="tile-value small">{dispatch.paused ? 'paused' : 'running'}</span>
            <button class="tile-action" type="button" onclick={toggleDispatch} disabled={toggling}>
              {toggling ? '…' : dispatch.paused ? 'Resume' : 'Pause'}
            </button>
          </div>
        {/if}

        {#if budget && budgetLimbs.length > 0}
          <div class="tile" class:warn={budgetLimbs.some((l) => l.near)} class:bad={budgetLimbs.some((l) => l.over)}>
            <span class="tile-label">Budget · per {Math.round(budget.windowMs / 3_600_000)}h</span>
            {#each budgetLimbs as l (l.label)}
              {#key l.label}<span class="tile-line fresh" class:warn={l.near} class:bad={l.over}>{l.label}</span>{/key}
            {/each}
          </div>
        {/if}

        {#if rateLimit}
          <div class="tile" class:warn={rateHealth === 'low' || rateHealth === 'stale'} class:bad={rateHealth === 'exhausted'}>
            <span class="tile-label">GitHub API</span>
            {#if rateHealth === 'stale'}
              <span class="tile-value small">unknown</span>
              <span class="tile-line muted">probe last ran {formatRelativeTime(rateLimit.checkedAt, now)}</span>
            {:else}
              {#key rateLimit.core.remaining}
                <span class="tile-value small fresh">{rateLimit.core.remaining.toLocaleString()}</span>
              {/key}
              <span class="tile-line muted">of {rateLimit.core.limit.toLocaleString()} · resets {formatClockTime(rateLimit.core.resetAt)}</span>
            {/if}
          </div>
        {/if}

        {#if status.workers.length === 0}
          <div class="tile bad">
            <span class="tile-label">Workers</span>
            <span class="tile-value small">no heartbeat</span>
          </div>
        {/if}
        {#each status.workers as w (w.worker)}
          {@const version = workerVersionState(w)}
          <div class="tile" class:bad={isStale(w)} class:warn={!isStale(w) && version === 'stale'}>
            <span class="tile-label">Worker · {w.worker}</span>
            <span class="tile-value small">{isStale(w) ? 'stale' : 'alive'}</span>
            <span class="tile-line muted">seen {formatRelativeTime(w.lastSeen, now)}</span>
            {#if version === 'stale'}
              <span class="tile-line warn" title="Running {w.buildSha}; main is {w.checkoutSha}. Run robot-refresh to deploy.">
                {w.buildSha} · behind main
              </span>
            {:else if version === 'current'}
              <span class="tile-line muted mono">{w.buildSha}</span>
            {:else}
              <span class="tile-line muted">build unknown</span>
            {/if}
          </div>
        {/each}

        {#if status.needsHuman.length > 0}
          <div class="tile needs wide">
            <span class="tile-label">Needs you · {status.needsHuman.length}</span>
            {#each status.needsHuman as t (t.id)}
              <a class="tile-line" href="/devops/tickets/{t.displayId}">
                <span class="mono">{t.displayId}</span> {t.title}
              </a>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style lang="scss" src="./AgentFleet.scss"></style>
