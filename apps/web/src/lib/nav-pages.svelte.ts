import { moveNavPage, navPagePath, type NavPage } from '@dashboard/shared';
import type { RoutedPage } from './nav-utils';
import { toast } from './toast-store.svelte';

/**
 * User-managed nav pages (PD-969 — pages become data).
 *
 * Loaded once at boot, like `page-widgets.svelte.ts` and for the same reason: the list is a
 * handful of rows, and having it up front keeps the nav, the top-bar title and `canArrange`
 * synchronous derivations. Moves are optimistic — the same `moveNavPage` the server runs is
 * applied locally first, then replaced by the server's answer, or reverted with a toast.
 */

const BASE = '/api/shell/nav-pages';

let _pages = $state<NavPage[]>([]);
let _loaded = $state(false);

export const navPages = {
  get loaded() {
    return _loaded;
  },

  get list(): NavPage[] {
    return _pages;
  },

  byId(id: string): NavPage | undefined {
    return _pages.find((p) => p.id === id);
  },

  /** Each page with its current route, in the shape nav-utils' pure helpers take. */
  get routes(): RoutedPage[] {
    return _pages.map((p) => ({ id: p.id, title: p.title, route: navPagePath(_pages, p.id) }));
  },

  async load(): Promise<void> {
    try {
      const res = await fetch(BASE);
      if (!res.ok) throw new Error(String(res.status));
      _pages = (await res.json()) as NavPage[];
    } catch {
      toast.show('Could not load your pages.', 'error');
    } finally {
      _loaded = true;
    }
  },

  async move(id: string, parentId: string | null, index: number): Promise<void> {
    const previous = _pages;
    const local = moveNavPage(_pages, id, parentId, index);
    if ('error' in local) return; // the drop math already refuses these; nothing to send
    _pages = local.pages;

    try {
      const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId, order: index }),
      });
      if (!res.ok) throw new Error(String(res.status));
      _pages = (await res.json()) as NavPage[];
    } catch {
      _pages = previous;
      toast.show('Could not move that page.', 'error');
    }
  },
};
