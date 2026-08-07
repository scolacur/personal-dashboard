<script lang="ts">
  import type { SystemStatus } from '@dashboard/shared';
  import { pauseDispatch, resumeDispatch } from './devops/api';
  import { describeDispatch } from './dispatch-killswitch-utils';

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
      <span class="ks-label">
        {#if view.mode === 'paused'}⛔ {/if}{view.label}
      </span>
      {#if view.detail}
        <span class="ks-detail">{view.detail}</span>
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
      <span class="ks-note">won't re-arm until the session limit resets</span>
    {/if}
  </div>
{/if}

<style lang="scss" src="./DispatchKillswitch.scss"></style>
