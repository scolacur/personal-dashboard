<script lang="ts">
  import type { Snippet } from 'svelte';

  let { name, children }: { name: string; children: Snippet } = $props();

  let flipped = $state(false);
</script>

<div class="widget-scene">
  <div class="widget-card" class:flipped>
    <div class="widget-face widget-front">
      {@render children()}
      <button
        class="flip-btn"
        onclick={() => (flipped = !flipped)}
        aria-label="Flip widget"
      >↻</button>
    </div>
    <div class="widget-face widget-back">
      <div class="rear-content">
        <span class="rear-title">{name}</span>
        <p class="rear-hint">Rear panel · Settings coming soon</p>
      </div>
      <button
        class="flip-btn"
        onclick={() => (flipped = !flipped)}
        aria-label="Flip widget back"
      >↻</button>
    </div>
  </div>
</div>

<style lang="scss" src="./Widget.scss"></style>
