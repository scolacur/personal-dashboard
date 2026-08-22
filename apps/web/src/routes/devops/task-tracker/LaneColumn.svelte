<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * One Ticket lane of the board (grid row 4) — the cell chrome, its `+` affordance, and the
   * drop target. The cards themselves come in as `children`, because the drag handlers that
   * wire them up live on the page alongside the board's drag state.
   */
  let {
    label,
    count,
    gridColumn,
    dragOver = false,
    addDisabled = false,
    showDropEnd = false,
    onAdd,
    onDragOver,
    onDrop,
    children,
  }: {
    label: string;
    count: number;
    /** 1-based column in the board grid. */
    gridColumn: number;
    dragOver?: boolean;
    addDisabled?: boolean;
    /** Render the append-target insertion line below the last card. */
    showDropEnd?: boolean;
    onAdd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    children: Snippet;
  } = $props();
</script>

<section class="ticket-cell" class:drag-over={dragOver} style="grid-column: {gridColumn}">
  <button
    class="column-add-btn"
    type="button"
    title="Add ticket to {label}"
    aria-label="Add ticket to {label}"
    onclick={onAdd}
    disabled={addDisabled}
  >+</button>
  <div class="column-body" role="list" ondragover={onDragOver} ondrop={onDrop}>
    {@render children()}
    {#if showDropEnd}
      <div class="drop-end"></div>
    {/if}
    {#if count === 0}
      <p class="empty">—</p>
    {/if}
  </div>
</section>

<style lang="scss" src="./LaneColumn.scss"></style>
