import type { PageWidget, PageWidgetMap } from '@dashboard/shared';
import { toast } from './toast-store.svelte';

/**
 * Page-membership store for the dashboard shell (PD-334, D-071).
 *
 * **Loaded once at boot, not per navigation.** The whole map is tens of rows, and loading it up
 * front is what keeps `canArrange` in the top nav and the grid itself *synchronous derivations* —
 * exactly the shape they had when membership was a registry field. Fetching per navigation would
 * make `canArrange` async (the Arrange button popping in late) and force the grid to distinguish
 * "this page is empty" from "not loaded yet", a state it has never needed.
 *
 * Writes are **optimistic with revert**: the store updates immediately and the PUT follows. A
 * server store can fail where `localStorage` effectively could not — and fails *likely*, since
 * every deploy restarts the container — so a silently swallowed failure would mean a widget the
 * user added is simply gone on next load. `layout.ts`'s old bare `catch {}` was fine against
 * `localStorage` and is not fine here.
 */

const BASE = '/api/shell/pages';

let _pages = $state<PageWidgetMap>({});
let _loaded = $state(false);

async function put(pageId: string, widgets: PageWidget[]): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(pageId)}/widgets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(widgets),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}

export const pageWidgets = {
  /** False until the boot load resolves. Only the initial paint should care. */
  get loaded() {
    return _loaded;
  },

  /** A page's widgets, in order. Unknown page ids read as empty — pages need no row to exist. */
  forPage(pageId: string): PageWidget[] {
    return _pages[pageId] ?? [];
  },

  /** Load every page's membership. Called once from the root layout. */
  async load(): Promise<void> {
    try {
      const res = await fetch(`${BASE}/widgets`);
      if (!res.ok) throw new Error(String(res.status));
      _pages = (await res.json()) as PageWidgetMap;
    } catch {
      // Leave the map empty and say so. Rendering every page as empty without explanation
      // looks exactly like a dashboard that lost its contents.
      toast.show('Could not load your dashboard layout.', 'error');
    } finally {
      // Set regardless: a failed load is settled, not pending, and the grid must stop waiting.
      _loaded = true;
    }
  },

  /**
   * Replace a page's widgets, optimistically.
   *
   * `order` is renormalised from array position on the server, so callers pass the array in the
   * order they want and need not maintain the field.
   */
  async set(pageId: string, widgets: PageWidget[]): Promise<void> {
    const previous = _pages[pageId];
    _pages = { ..._pages, [pageId]: widgets.map((w, i) => ({ ...w, order: i })) };

    try {
      await put(pageId, widgets);
    } catch {
      // Put the user's view back to what is actually stored, so the UI never claims a save
      // that did not happen.
      if (previous === undefined) {
        const { [pageId]: _dropped, ...rest } = _pages;
        _pages = rest;
      } else {
        _pages = { ..._pages, [pageId]: previous };
      }
      toast.show("Couldn't save — check the server.", 'error');
    }
  },

  /** Add a widget to the end of a page. No-op if it is already there (the PK forbids duplicates). */
  async add(pageId: string, widgetId: string, span: { cols: number; rows: number }): Promise<void> {
    const current = this.forPage(pageId);
    if (current.some((w) => w.widgetId === widgetId)) return;
    await this.set(pageId, [
      ...current,
      { widgetId, order: current.length, cols: span.cols, rows: span.rows },
    ]);
  },

  async remove(pageId: string, widgetId: string): Promise<void> {
    const current = this.forPage(pageId);
    if (!current.some((w) => w.widgetId === widgetId)) return;
    await this.set(
      pageId,
      current.filter((w) => w.widgetId !== widgetId),
    );
  },
};
