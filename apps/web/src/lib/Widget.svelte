<script lang="ts">
  import type { WidgetEmbed } from './widgets';

  let {
    title,
    description,
    route,
    embed,
  }: { title: string; description: string; route: string; embed?: WidgetEmbed } = $props();

  let flipped = $state(false);

  function flip() {
    flipped = !flipped;
  }

  // Uppercase alias so the template treats this as a component, not an HTML element.
  // $derived ensures it updates if embed changes at runtime (though in practice it's static).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let EmbedComponent = $derived(embed?.component as any);
</script>

<div
  class="widget"
  class:widget-embedded={!!embed}
  style:--col-span={embed?.span.cols ?? 1}
  style:--row-span={embed?.span.rows ?? 1}
>
  {#if embed && EmbedComponent}
    <EmbedComponent
      variant="widget"
      view={flipped ? 'manage' : 'generator'}
    />
    <button
      type="button"
      class="flip-btn"
      onclick={flip}
      aria-label={flipped ? 'Back to generator' : 'Manage ideas'}
    >↺</button>
  {:else}
    <div class="widget-inner" class:flipped>
      <div class="face face-front">
        <!-- Stretched link: covers the whole face so clicking anywhere on the
             card navigates — except the flip button, which sits above it. -->
        <a href={route} class="stretched-link" aria-label={title}></a>
        <h2>{title}</h2>
        <p>{description}</p>
        <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
      </div>
      <div class="face face-back">
        <p class="back-name">{title}</p>
        <p class="back-label">Rear panel</p>
        <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
      </div>
    </div>
  {/if}
</div>

<style lang="scss" src="./Widget.scss"></style>
