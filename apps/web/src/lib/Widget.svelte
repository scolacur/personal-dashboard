<script lang="ts">
  import type { WidgetEmbed } from './widgets';

  let {
    title,
    description,
    route,
    embed,
    arranging = false,
    cols,
    rows,
    dragging = false,
    dropTarget = false,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onResizeStart,
  }: {
    title: string;
    description: string;
    route: string;
    embed?: WidgetEmbed;
    arranging?: boolean;
    cols?: number;
    rows?: number;
    dragging?: boolean;
    dropTarget?: boolean;
    onDragStart?: () => void;
    onDragOver?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    onDragEnd?: () => void;
    onResizeStart?: (e: MouseEvent) => void;
  } = $props();

  let flipped = $state(false);

  function flip() {
    flipped = !flipped;
  }

  const effectiveCols = $derived(cols ?? embed?.span.cols ?? 1);
  const effectiveRows = $derived(rows ?? embed?.span.rows ?? 1);

  // Uppercase alias so the template treats this as a component, not an HTML element.
  // $derived ensures it updates if embed changes at runtime (though in practice it's static).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let EmbedComponent = $derived(embed?.component as any);
</script>

<div
  class="widget"
  class:widget-embedded={!!embed}
  class:arranging
  class:dragging
  class:drop-target={dropTarget}
  style:--col-span={effectiveCols}
  style:--row-span={effectiveRows}
  role={arranging ? 'listitem' : undefined}
  aria-label={arranging ? title : undefined}
  draggable={arranging}
  ondragstart={arranging ? onDragStart : undefined}
  ondragover={arranging ? onDragOver : undefined}
  ondrop={arranging ? onDrop : undefined}
  ondragend={arranging ? onDragEnd : undefined}
>
  {#if embed && EmbedComponent}
    <div class="widget-card-header">
      <span class="widget-card-title">{title}</span>
    </div>
    <div class="widget-card-content">
      <EmbedComponent
        variant="widget"
        view={flipped ? 'manage' : 'generator'}
      />
    </div>
    {#if !arranging}
      <a href={route} class="expand-link">Expand ↗</a>
      <button
        type="button"
        class="flip-btn"
        onclick={flip}
        aria-label={flipped ? 'Back to generator' : 'Manage ideas'}
      >↺</button>
    {/if}
  {:else}
    <div class="widget-inner" class:flipped>
      <div class="face face-front">
        <!-- Stretched link: covers the whole face so clicking anywhere on the
             card navigates — except the flip button, which sits above it. -->
        {#if !arranging}
          <a href={route} class="stretched-link" aria-label={title}></a>
        {/if}
        <h2>{title}</h2>
        <p>{description}</p>
        {#if !arranging}
          <a href={route} class="expand-link">Expand ↗</a>
          <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
        {/if}
      </div>
      <div class="face face-back">
        <p class="back-name">{title}</p>
        <p class="back-label">Rear panel</p>
        {#if !arranging}
          <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
        {/if}
      </div>
    </div>
  {/if}
  {#if arranging}
    <div class="resize-handle" onmousedown={onResizeStart} role="presentation"></div>
  {/if}
</div>

<style lang="scss" src="./Widget.scss"></style>
