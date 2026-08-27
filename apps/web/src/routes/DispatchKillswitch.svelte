<script lang="ts">
  import type { SystemStatus } from '@dashboard/shared';
  import { pauseDispatch, resumeDispatch } from './devops/api';
  import { countdownLabel, describeDispatch, fleetRows } from './dispatch-killswitch-utils';

  // PD-410 — the loop-wide killswitch, in the nav rather than inside the Site Status widget.
  // Same C4 pause the widget drives (`robot_state.dispatch_paused`); no new backend. The widget
  // stays as the detailed readout — this is the always-there control and, more importantly, the
  // always-there WARNING. A paused loop that looks like an idle loop is the failure this fixes.
  //
  // Scoped to Dev Ops routes by the layout, following the DeployStatus precedent (PD-414): the
  // section where the loop is actually operated.

  // Matches SystemStatus's cadence. The loop ticks ~15s, but two independent pollers on /devops
  // (this and the widget) at 15s would double the request rate for no operational gain.
  const REFRESH_MS = 30_000;
  // The countdown is a SEPARATE, faster timer. Driving `now` off the poll meant a mm:ss clock that
  // jumped 30 seconds at a time — which does not read as a slow clock, it reads as a stopped one.
  const TICK_MS = 1_000;

  let status = $state<SystemStatus | null>(null);
  let now = $state(Date.now());
  let toggling = $state(false);

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
    const poll = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => {
      now = Date.now();
    }, TICK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  });

  let view = $derived(describeDispatch(status, now));
  let rows = $derived(fleetRows(status));
  let countdown = $derived(countdownLabel(view?.endsBy ?? null, now));

  // The toggle reflects whether the loop is ARMED, which is not the same as whether it is
  // dispatching: a hold stops dispatch without unsetting the flag. Holds get their own row below
  // rather than flipping the switch to Off, because Off means "a human turned it off".
  let loopOn = $derived(view !== null && view.mode !== 'paused');

  async function toggle(): Promise<void> {
    if (toggling || !view || view.action === null) return;
    toggling = true;
    try {
      const next =
        view.action === 'resume'
          ? await resumeDispatch()
          : // Name the origin in the reason so a later reader knows this was a deliberate human
            // pause from the nav, not a fault the loop raised on itself.
            await pauseDispatch('paused by human (nav killswitch)');
      if (status) status = { ...status, dispatch: next };
    } catch {
      // Leave the current state; the next poll reconciles.
    } finally {
      toggling = false;
    }
  }
</script>

{#if view}
  <div class="killswitch mode-{view.mode}">
    <div class="ks-loop">
      <button
        class="ks-toggle"
        class:ks-toggle--on={loopOn}
        onclick={toggle}
        disabled={toggling || view.action === null}
        role="switch"
        aria-checked={loopOn}
        aria-label={loopOn ? 'Turn the Robot loop off' : 'Turn the Robot loop on'}
        title={view.action === null ? `${view.label} — ends by itself, nothing to turn off` : 'Arm or disarm Robot dispatch'}
      >
        <span class="ks-toggle-label">Loop</span>
        <span class="ks-track"><span class="ks-thumb"></span></span>
        <span class="ks-toggle-state">{toggling ? '…' : loopOn ? 'On' : 'Off'}</span>
      </button>

      {#if view.detail || countdown}
        <!-- Under the toggle, not beside it: this is why the loop is in the state it is in, and it
             changes length constantly (a pause reason, a hold phase, a ticking clock). Inline, it
             shoved the fleet box around on every tick. -->
        <span class="ks-reason">
          {#if view.mode === 'maintenance'}
            <a class="ks-reason-link" href="/devops/jobs#maintenance-holds">{view.label}</a>
          {:else if view.mode === 'holding'}
            {view.label}
          {/if}
          {#if view.detail}<span class="ks-detail">{view.detail}</span>{/if}
          {#if countdown}<span class="ks-countdown" title="Dispatch resumes when the window closes">{countdown}</span>{/if}
        </span>
      {/if}

      {#if view.resumeBlockedByHold}
        <!-- Both halts are active. Turning the loop back on clears the pause but `robot.ts` still
             gates on the hold, so dispatch will not actually restart yet — say so rather than let
             the click imply it was enough. Keyed on WHICH hold, not on whether there is a
             countdown: a queued maintenance hold has no end time yet. -->
        <span class="ks-note">
          {view.holdKind !== null
            ? "won't re-arm until the session limit resets"
            : "won't re-arm until the maintenance hold closes"}
        </span>
      {/if}
    </div>

    <div class="ks-fleet" title="Robot fleet by state">
      {#each rows as row (row.key)}
        <svelte:element
          this={row.href ? 'a' : 'span'}
          href={row.href}
          class="ks-row ks-row--{row.key}"
          class:ks-row--zero={row.count === 0}
        >
          <span class="ks-count">{row.count}</span>
          <span class="ks-row-label">{row.label}</span>
        </svelte:element>
      {/each}
    </div>
  </div>
{/if}

<style lang="scss" src="./DispatchKillswitch.scss"></style>
