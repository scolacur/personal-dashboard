<script lang="ts">
  import { widgets } from '$lib/widgets';
  import Widget from '$lib/Widget.svelte';
  import PomodoroTimer from './widgets/pomodoro/PomodoroTimer.svelte';
  import DeployStatus from './DeployStatus.svelte';
</script>

<DeployStatus />

{#if widgets.length === 0}
  <p style="color: var(--muted); text-align: center; margin-top: 4rem; font-size: 0.875rem;">
    No widgets yet — add one in <code>lib/widgets.ts</code>
  </p>
{:else}
  <div class="grid">
    {#each widgets as w (w.route)}
      {#if w.id === 'pomodoro'}
        <div class="pomodoro-tile">
          <PomodoroTimer />
        </div>
      {:else}
        <Widget title={w.title} description={w.description} route={w.route} />
      {/if}
    {/each}
  </div>
{/if}

<style lang="scss" src="./+page.scss"></style>
