<script lang="ts">
  import type { PageWidget } from '@dashboard/shared';
  import { arrangeMode } from './arrange.svelte';
  import { pageWidgets } from './page-widgets.svelte';
  import { resolvePlacements } from './layout';
  import { widgets as registry, defaultSpan } from './widgets';
  import Widget from './Widget.svelte';

  let { pageId }: { pageId: string } = $props();

  // Membership comes from the store, which is loaded once at boot — so this stays a plain
  // synchronous derivation, exactly as it was when it read the registry (D-071). The widget
  // list is no longer a prop: which widgets are on a page is the store's answer, not a caller's.
  const saved = $derived(pageWidgets.forPage(pageId));

  // A resize streams many intermediate values and only the last is worth a request. `pending`
  // holds the in-flight shape so the grid renders it without a round-trip per mousemove; it is
  // cleared once the real value is committed.
  let pending = $state<PageWidget[] | null>(null);
  const layouts = $derived(pending ?? saved);
  const resolved = $derived(resolvePlacements(layouts, registry));

  /** Show `next` immediately; when `save`, persist it too (optimistic — the store reverts on
   *  failure and raises a toast). */
  function applyLayouts(next: PageWidget[], save = false) {
    if (save) {
      pending = null;
      void pageWidgets.set(pageId, next);
    } else {
      pending = next;
    }
  }

  let gridEl = $state<HTMLElement | null>(null);

  // ── Drag-to-reorder ───────────────────────────────────────────────────────────
  let dragId = $state<string | null>(null);
  let dropTargetId = $state<string | null>(null);

  function startDrag(id: string) {
    dragId = id;
    dropTargetId = null;
  }

  function handleDragOver(id: string, e: DragEvent) {
    e.preventDefault(); // required to allow drop
    if (dragId && dragId !== id) dropTargetId = id;
  }

  function handleDrop(id: string, e: DragEvent) {
    e.preventDefault();
    if (!dragId || dragId === id) {
      endDrag();
      return;
    }
    const fromIdx = layouts.findIndex((l) => l.widgetId === dragId);
    const toIdx = layouts.findIndex((l) => l.widgetId === id);
    if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
      const next = [...layouts];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      applyLayouts(
        next.map((l, i) => ({ ...l, order: i })),
        true,
      );
    }
    endDrag();
  }

  function endDrag() {
    dragId = null;
    dropTargetId = null;
    // Belt-and-suspenders: a finished drag means no interaction is in flight, so
    // clear any lingering resize state too (resize and reorder are exclusive).
    resizeId = null;
    resizeAnchor = null;
  }

  // ── Corner-handle resize ──────────────────────────────────────────────────────
  interface GridMeasurements {
    colWidth: number;
    rowHeight: number;
    maxCols: number;
    colGap: number;
    rowGap: number;
  }

  let resizeId = $state<string | null>(null);
  let resizeAnchor = $state<({ x: number; y: number; cols: number; rows: number } & GridMeasurements) | null>(null);

  // Grid geometry doesn't change mid-drag, so measure once at resize start and
  // cache it on the anchor — avoids a forced reflow on every mousemove.
  function getGridMeasurements(): GridMeasurements {
    if (!gridEl) return { colWidth: 260, rowHeight: 140, maxCols: 4, colGap: 16, rowGap: 16 };
    const style = getComputedStyle(gridEl);
    // getComputedStyle resolves gridTemplateColumns to the used value — a
    // space-separated list of pixel track sizes, one per rendered column.
    const colTracks = style.gridTemplateColumns.split(' ');
    const colWidth = parseFloat(colTracks[0]) || 260;
    const maxCols = colTracks.length;
    const rowHeight = parseFloat(style.gridAutoRows) || 140;
    const colGap = parseFloat(style.columnGap) || 16;
    const rowGap = parseFloat(style.rowGap) || 16;
    return { colWidth, rowHeight, maxCols, colGap, rowGap };
  }

  function startResize(id: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const layout = layouts.find((l) => l.widgetId === id);
    if (!layout) return; // nothing to anchor to — don't arm a resize
    resizeId = id;
    resizeAnchor = {
      x: e.clientX,
      y: e.clientY,
      cols: layout.cols,
      rows: layout.rows,
      ...getGridMeasurements(),
    };
  }

  function handleResizeMove(e: MouseEvent) {
    if (!resizeId || !resizeAnchor) return;
    const { colWidth, rowHeight, maxCols, colGap, rowGap } = resizeAnchor;
    const dx = e.clientX - resizeAnchor.x;
    const dy = e.clientY - resizeAnchor.y;
    const newCols = Math.max(
      1,
      Math.min(maxCols, resizeAnchor.cols + Math.round(dx / (colWidth + colGap))),
    );
    const newRows = Math.max(
      1,
      Math.min(6, resizeAnchor.rows + Math.round(dy / (rowHeight + rowGap))),
    );
    applyLayouts(
      layouts.map((l) => (l.widgetId === resizeId ? { ...l, cols: newCols, rows: newRows } : l)),
    );
  }

  function handleResizeEnd() {
    // Commit whatever the drag left on screen, in one write.
    if (resizeId) applyLayouts([...layouts], true);
    resizeId = null;
    resizeAnchor = null;
  }

  /**
   * Restore this page's *arrangement* — registry order and each widget's default span.
   *
   * Membership is untouched: with no registry `pages` field left there is no default set of
   * widgets to reset to, and silently re-adding widgets the user removed is the exact failure
   * the seed guard exists to prevent (D-071). This resets where things sit, not what is there.
   */
  function resetLayout() {
    const registryOrder = new Map(registry.map((w, i) => [w.id, i]));
    const next = resolvePlacements(layouts, registry)
      .slice()
      .sort(
        (a, b) =>
          (registryOrder.get(a.widget.id) ?? Number.MAX_SAFE_INTEGER) -
          (registryOrder.get(b.widget.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(({ widget }, i) => ({ widgetId: widget.id, order: i, ...defaultSpan(widget) }));
    applyLayouts(next, true);
  }
</script>

<svelte:document
  onmousemove={resizeId ? handleResizeMove : undefined}
  onmouseup={resizeId ? handleResizeEnd : undefined}
/>

{#if resolved.length === 0}
  <!-- An empty page is a normal state now that membership is user state (D-071) — not the
       "stubbed out, nothing built yet" it used to mean. PD-334's next slice replaces this with
       the ghost "+" card, which is both the empty state and the way out of it. -->
  <p class="page-empty">No widgets on this page yet.</p>
{:else}
  {#if arrangeMode.active}
    <div class="arrange-toolbar">
      <span class="arrange-hint">Drag to reorder · Drag corner to resize</span>
      <button class="btn-reset" onclick={resetLayout}>Reset arrangement</button>
      <button class="btn-done" onclick={arrangeMode.exit}>Done</button>
    </div>
  {/if}
  <div class="grid" class:arranging={arrangeMode.active} bind:this={gridEl}>
    {#each resolved as { widget, placement } (widget.id)}
      <Widget
        title={widget.title}
        description={widget.description}
        route={widget.route}
        embed={widget.embed}
        arranging={arrangeMode.active}
        cols={placement.cols}
        rows={placement.rows}
        dragging={dragId === widget.id}
        dropTarget={dropTargetId === widget.id}
        onDragStart={() => startDrag(widget.id)}
        onDragOver={(e) => handleDragOver(widget.id, e)}
        onDrop={(e) => handleDrop(widget.id, e)}
        onDragEnd={endDrag}
        onResizeStart={(e) => startResize(widget.id, e)}
      />
    {/each}
  </div>
{/if}

<style lang="scss" src="./WidgetGrid.scss"></style>
