import type { NavPage } from './shell';

/**
 * Pure tree logic over the flat `NavPage[]` list (PD-969 — nav pages become data).
 *
 * Shared by the server (which validates and applies a move) and the web client (which applies the
 * same move optimistically), so the two cannot disagree about where a page lands.
 */

/** Route prefix for user-managed pages. Pinned built-ins keep their code-defined routes. */
export const NAV_PAGE_ROUTE_PREFIX = '/p';

/** A page's siblings under `parentId`, in order. */
export function navChildren(pages: NavPage[], parentId: string | null): NavPage[] {
  return pages.filter((p) => p.parentId === parentId).sort((a, b) => a.order - b.order);
}

/** True when `id` is `ancestorId` itself or sits anywhere beneath it. */
export function isSelfOrDescendant(
  pages: NavPage[],
  ancestorId: string,
  id: string | null,
): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  let cur = id;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

export type MoveError = 'NOT_FOUND' | 'PARENT_NOT_FOUND' | 'CYCLE';

/**
 * Move page `id` under `parentId` at sibling position `index` (counted among the new siblings
 * *excluding* the moved page, clamped to range). Its descendants travel with it, untouched.
 *
 * Returns the whole list with both affected sibling groups renumbered contiguously, or an error.
 */
export function moveNavPage(
  pages: NavPage[],
  id: string,
  parentId: string | null,
  index: number,
): { pages: NavPage[] } | { error: MoveError } {
  const moving = pages.find((p) => p.id === id);
  if (!moving) return { error: 'NOT_FOUND' };
  if (parentId !== null && !pages.some((p) => p.id === parentId))
    return { error: 'PARENT_NOT_FOUND' };
  // Covers dropping a page into itself or into its own subtree.
  if (parentId !== null && isSelfOrDescendant(pages, id, parentId)) return { error: 'CYCLE' };

  const newOrder = new Map<string, { parentId: string | null; order: number }>();

  // Close the gap the page leaves behind.
  navChildren(pages, moving.parentId)
    .filter((p) => p.id !== id)
    .forEach((p, i) => newOrder.set(p.id, { parentId: p.parentId, order: i }));

  // Open a slot where it lands.
  const siblings = navChildren(pages, parentId).filter((p) => p.id !== id);
  const at = Math.max(0, Math.min(Math.floor(index), siblings.length));
  siblings.splice(at, 0, { ...moving, parentId });
  siblings.forEach((p, i) => newOrder.set(p.id, { parentId, order: i }));

  return {
    pages: pages.map((p) => {
      const n = newOrder.get(p.id);
      return n ? { ...p, parentId: n.parentId, order: n.order } : p;
    }),
  };
}

/** One row of the tree flattened depth-first, in display order. */
export interface NavRow {
  page: NavPage;
  depth: number;
  hasChildren: boolean;
}

export function flattenNavTree(pages: NavPage[]): NavRow[] {
  const rows: NavRow[] = [];
  const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
    for (const p of navChildren(pages, parentId)) {
      if (seen.has(p.id)) continue; // defensive: a corrupt cycle must not hang the nav
      seen.add(p.id);
      const kids = navChildren(pages, p.id);
      rows.push({ page: p, depth, hasChildren: kids.length > 0 });
      visit(p.id, depth + 1, seen);
    }
  };
  visit(null, 0, new Set());
  return rows;
}

/** The chain from the top-level ancestor down to `id`, inclusive. Empty if unknown. */
export function navAncestry(pages: NavPage[], id: string): NavPage[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain: NavPage[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return chain;
}

/** The canonical route of a page: `/p/<ancestor slugs>/<slug>`. */
export function navPagePath(pages: NavPage[], id: string): string {
  const chain = navAncestry(pages, id);
  if (chain.length === 0) return NAV_PAGE_ROUTE_PREFIX;
  return `${NAV_PAGE_ROUTE_PREFIX}/${chain.map((p) => p.slug).join('/')}`;
}

/**
 * Resolve the slug segments after `/p/` to a page.
 *
 * The last segment alone decides, because slugs are unique across all pages. So a path that was
 * right before a move (or a rename of an ancestor's slug) still finds its page; `canonical` then
 * says whether the caller should redirect to the current path.
 */
export function resolveNavPath(
  pages: NavPage[],
  segments: string[],
): { page: NavPage; path: string; canonical: boolean } | null {
  const last = segments.filter(Boolean).at(-1);
  if (last === undefined) return null;
  const page = pages.find((p) => p.slug === last);
  if (!page) return null;
  const path = navPagePath(pages, page.id);
  const asked = `${NAV_PAGE_ROUTE_PREFIX}/${segments.filter(Boolean).join('/')}`;
  return { page, path, canonical: asked === path };
}
