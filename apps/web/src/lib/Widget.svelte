<script lang="ts">
  import type { Snippet } from 'svelte';

  let { name, children }: { name: string; children: Snippet } = $props();

  let flipped = $state(false);
</script>

<div class="widget" class:flipped>
  <div class="widget-inner">
    <div class="widget-front">
      {@render children()}
      <button
        class="flip-btn"
        onclick={() => (flipped = !flipped)}
        aria-label="Flip to rear panel"
      >↺</button>
    </div>
    <div class="widget-rear">
      <p class="rear-name">{name}</p>
      <p class="rear-hint">Rear panel</p>
      <button
        class="flip-btn"
        onclick={() => (flipped = !flipped)}
        aria-label="Flip to front"
      >↺</button>
    </div>
  </div>
</div>

<style lang="scss" src="./Widget.scss"></style>
