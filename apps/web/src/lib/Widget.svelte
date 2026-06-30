<script lang="ts">
  import type { Snippet } from 'svelte';

  let { name, children }: { name: string; children: Snippet } = $props();

  let flipped = $state(false);
</script>

<div class="widget">
  <div class="widget-inner" class:flipped>
    <div class="widget-face front">
      {@render children()}
    </div>
    <div class="widget-face back">
      <span class="back-name">{name}</span>
      <span class="back-label">rear panel</span>
    </div>
  </div>
  <button class="flip-btn" onclick={() => (flipped = !flipped)} aria-label="Flip widget">
    ↺
  </button>
</div>

<style lang="scss" src="./Widget.scss"></style>
