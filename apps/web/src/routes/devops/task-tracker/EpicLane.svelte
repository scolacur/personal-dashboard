<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { EpicBandCell } from '../epic-logic';

  /**
   * One cell of the board's Epic band (grid row 2). Like `LaneColumn` it owns the cell chrome and
   * the drop target; the Epic cards arrive as `children`.
   */
  let {
    cell,
    dragOver = false,
    addDisabled = false,
    onAdd,
    onDragOver,
    onDrop,
    children,
  }: {
    cell: EpicBandCell;
    dragOver?: boolean;
    addDisabled?: boolean;
    onAdd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    children: Snippet;
  } = $props();
</script>

<div
  class="epic-cell"
  class:in-progress={cell.lane === 'in_progress'}
  class:drag-over={dragOver}
  style="grid-column: {cell.colStart} / span {cell.colSpan}"
  ondragover={onDragOver}
  ondrop={onDrop}
  role="list"
>
  {#if cell.canAdd}
    <button
      class="column-add-btn epic-add"
      type="button"
      title="Add Epic to {cell.label}"
      aria-label="Add Epic to {cell.label}"
      onclick={onAdd}
      disabled={addDisabled}
    >+ Epic</button>
  {/if}
  {@render children()}
</div>

<style lang="scss" src="./EpicLane.scss"></style>
