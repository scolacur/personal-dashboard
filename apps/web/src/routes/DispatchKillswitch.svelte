<script lang="ts">
  import type { SystemStatus } from '@dashboard/shared';
  import { pauseDispatch, resumeDispatch } from './devops/api';
  import { countdownLabel, describeDispatch, fleetCounts } from './dispatch-killswitch-utils';

  // PD-410 — the loop-wide killswitch, in the nav rather than inside the Site Status widget.
  // Same C4 pause the widget drives (`robot_state.dispatch_paused`); no new backend. The widget
  // stays as the detailed readout — this is the always-there control and, more importantly, the
  // always-there WARNING. A paused loop that looks like an idle loop is the failure this fixes.
  //
  // Scoped to Dev Ops routes by the layout, following the DeployStatus precedent (PD-414): the
  // section where the loop is actually operated. Deliberately not app-wide — a robot dispatch
  // control on the Pomodoro page is noise, and it would put a poll on every page in the app.

  // Matches SystemStatus's cadence. The loop ticks ~15s, but two independent pollers on /devops
  // (this and the widget) at 15s would double the request rate for no operational gain.
  const REFRESH_MS = 30_000;

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
    const timer = setInterval(() => {
      now = Date.now();
      load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  let view = $derived(describeDispatch(status, now));
  // The fleet breakdown answers the question the label cannot: the loop being armed and a Robot
  // actually running are different facts, and "Dispatch running" used to conflate them.
  let counts = $derived(fleetCounts(status));
  let countdown = $derived(countdownLabel(view?.endsBy ?? null, now));

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
    <span class="ks-state" title={view.detail ?? 'Robot dispatch is running'}>
      <span class="dot" aria-hidden="true"></span>
      {#if view.mode === 'maintenance'}
        <!-- The one mode with somewhere to go: the hold section is where you watch it, see which
             jobs ran, and press "Run now". Inherited from the separate hold pill this replaced —
             the pill was redundant next to the label, but its link was not. -->
        <a class="ks-label ks-label--link" href="/devops/jobs#maintenance-holds">{view.label}</a>
      {:else}
        <span class="ks-label">
          {#if view.mode === 'paused'}⛔ {/if}{view.label}
        </span>
      {/if}
      {#if countdown}
        <!-- Only a maintenance hold sets endsBy: its window is a fixed length, so a ticking clock
             is honest. A provider hold shows a wall-clock reset time instead (see endsBy's doc). -->
        <span class="ks-countdown" title="Dispatch resumes when the window closes">{countdown}</span>
      {/if}
      {#if view.detail}
        <span class="ks-detail">{view.detail}</span>
      {/if}
    </span>

    <span class="ks-counts" title="Robot fleet by state">
      <span class="ks-count" class:ks-count--live={counts.working > 0}>{counts.working} working</span>
      <span class="ks-count">{counts.queued} queued</span>
      <span class="ks-count">{counts.inReview} in review</span>
      {#if counts.needsYou > 0}
        <a class="ks-count ks-count--attention" href="/devops/task-tracker">{counts.needsYou} needs you</a>
      {/if}
    </span>

    {#if view.action}
      <button
        class="ks-btn"
        onclick={toggle}
        disabled={toggling}
        aria-label={view.action === 'resume' ? 'Resume Robot dispatch' : 'Pause Robot dispatch'}
      >
        {toggling ? '…' : view.action === 'resume' ? 'Resume' : 'Pause'}
      </button>
    {/if}

    {#if view.resumeBlockedByHold}
      <!-- Both halts are active. Resuming clears the pause but `robot.ts` still gates on the
           session-limit hold, so dispatch will not actually restart yet — say so rather than let
           the click imply it was enough. -->
      <!-- Keyed on WHICH hold, not on whether there is a countdown: a queued maintenance hold has
           no endsBy yet, and an endsBy check would call it a session limit. -->
      <span class="ks-note">
        {view.holdKind !== null
          ? "won't re-arm until the session limit resets"
          : "won't re-arm until the maintenance hold closes"}
      </span>
    {/if}
  </div>
{/if}

<style lang="scss" src="./DispatchKillswitch.scss"></style>
