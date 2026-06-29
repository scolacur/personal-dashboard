<script lang="ts">
  import { widgets } from '$lib/widgets';
  import Widget from '$lib/Widget.svelte';
</script>

{#if widgets.length === 0}
  <p style="color: var(--muted); text-align: center; margin-top: 4rem; font-size: 0.875rem;">
    No widgets yet — add one in <code>lib/widgets.ts</code>
  </p>
{:else}
  <div class="grid">
    {#each widgets as widget (widget.route)}
      <Widget name={widget.title}>
        <h2>{widget.title}</h2>
        <p>{widget.description}</p>
        <a href={widget.route} class="tile-open">Open →</a>
      </Widget>
    {/each}
  </div>
{/if}

<style lang="scss" src="./+page.scss"></style>
