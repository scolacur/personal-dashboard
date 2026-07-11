<script lang="ts">
  import type { WidgetMeta } from './widgets';
  import { arrangeMode } from './arrange.svelte';
  import { loadPageLayout, savePageLayout, clearPageLayout, defaultLayout } from './layout';
  import type { WidgetLayout } from './layout';
  import Widget from './Widget.svelte';

  let { pageId, widgetList }: { pageId: string; widgetList: WidgetMeta[] } = $props();

  // Writable-derived pattern: user mutations tracked separately; derived re-loads
  // from localStorage whenever the page changes (pageId or widgetList dependency).
  let _pageKey = $state('');
  let _userLayouts = $state<WidgetLayout[]>([]);

  const layouts = $derived.by(() => {
    if (_pageKey === pageId) return _userLayouts;
    return loadPageLayout(pageId, widgetList);
  });

  function applyLayouts(next: WidgetLayout[], save = false) {
    _pageKey = pageId;
    _userLayouts = next;
    if (save) savePageLayout(pageId, next);
  }

  let gridEl = $state<HTMLElement | null>(null);

  const metaById = $derived(new Map(widgetList.map((w) => [w.id, w])));
  const orderedWidgets = $derived(
    layouts.map((l) => metaById.get(l.id)).filter((w): w is WidgetMeta => w !== undefined),
  );

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
    const fromIdx = layouts.findIndex((l) => l.id === dragId);
    const toIdx = layouts.findIndex((l) => l.id === id);
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
  }

  // ── Corner-handle resize ──────────────────────────────────────────────────────
  let resizeId = $state<string | null>(null);
  let resizeAnchor = $state<{ x: number; y: number; cols: number; rows: number } | null>(null);

  function startResize(id: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeId = id;
    const layout = layouts.find((l) => l.id === id);
    if (layout) {
      resizeAnchor = { x: e.clientX, y: e.clientY, cols: layout.cols, rows: layout.rows };
    }
  }

  function getGridMeasurements(): { colWidth: number; rowHeight: number; maxCols: number } {
    if (!gridEl) return { colWidth: 260, rowHeight: 140, maxCols: 4 };
    const style = getComputedStyle(gridEl);
    const colTracks = style.gridTemplateColumns.split(' ');
    const colWidth = parseFloat(colTracks[0]) || 260;
    const maxCols = colTracks.length;
    const rowHeight = parseFloat(style.gridAutoRows) || 140;
    return { colWidth, rowHeight, maxCols };
  }

  const GAP = 16; // --space-md = 1rem = 16px

  function handleResizeMove(e: MouseEvent) {
    if (!resizeId || !resizeAnchor) return;
    const { colWidth, rowHeight, maxCols } = getGridMeasurements();
    const dx = e.clientX - resizeAnchor.x;
    const dy = e.clientY - resizeAnchor.y;
    const newCols = Math.max(
      1,
      Math.min(maxCols, resizeAnchor.cols + Math.round(dx / (colWidth + GAP))),
    );
    const newRows = Math.max(
      1,
      Math.min(6, resizeAnchor.rows + Math.round(dy / (rowHeight + GAP))),
    );
    applyLayouts(
      layouts.map((l) => (l.id === resizeId ? { ...l, cols: newCols, rows: newRows } : l)),
    );
  }

  function handleResizeEnd() {
    if (resizeId) savePageLayout(pageId, layouts);
    resizeId = null;
    resizeAnchor = null;
  }

  function resetLayout() {
    clearPageLayout(pageId);
    applyLayouts(defaultLayout(widgetList));
  }
</script>

<svelte:document
  onmousemove={resizeId ? handleResizeMove : undefined}
  onmouseup={resizeId ? handleResizeEnd : undefined}
/>

{#if widgetList.length === 0}
  <p class="page-empty">No widgets here yet — this page is stubbed out.</p>
{:else}
  {#if arrangeMode.active}
    <div class="arrange-toolbar">
      <span class="arrange-hint">Drag to reorder · Drag corner to resize</span>
      <button class="btn-reset" onclick={resetLayout}>Reset to default</button>
      <button class="btn-done" onclick={arrangeMode.exit}>Done</button>
    </div>
  {/if}
  <div class="grid" class:arranging={arrangeMode.active} bind:this={gridEl}>
    {#each orderedWidgets as w (w.id)}
      {@const layout = layouts.find((l) => l.id === w.id)}
      <Widget
        title={w.title}
        description={w.description}
        route={w.route}
        embed={w.embed}
        arranging={arrangeMode.active}
        cols={layout?.cols}
        rows={layout?.rows}
        dragging={dragId === w.id}
        dropTarget={dropTargetId === w.id}
        onDragStart={() => startDrag(w.id)}
        onDragOver={(e) => handleDragOver(w.id, e)}
        onDrop={(e) => handleDrop(w.id, e)}
        onDragEnd={endDrag}
        onResizeStart={(e) => startResize(w.id, e)}
      />
    {/each}
  </div>
{/if}

<style lang="scss" src="./WidgetGrid.scss"></style>
