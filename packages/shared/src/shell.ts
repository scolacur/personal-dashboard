/**
 * Dashboard shell types (PD-334, D-073).
 *
 * A widget's placement on a page: which page it is on (**membership**) plus where and how big
 * it sits there (**layout**). One row carries both, because the two are only ever read together
 * and a membership row with no layout would have to invent one anyway.
 *
 * Membership is entirely user state — the widget registry declares no placement (D-073), so
 * these rows are the only answer to "what is on this page?".
 */
export interface PageWidget {
  widgetId: string;
  /** Position within the page's auto-flow grid, ascending. */
  order: number;
  /** Grid span in integer multiples of the base card cell (D-053). */
  cols: number;
  rows: number;
}

/** Every page's membership, keyed by page id. The client loads this whole map once at boot. */
export type PageWidgetMap = Record<string, PageWidget[]>;

/**
 * A user-managed nav page (PD-969). Every page except the pinned built-ins (Home, Dev Ops) is one
 * of these: a data row that can be renamed, reordered and nested. Its widgets are the
 * `PageWidget` rows keyed by the same `id`.
 *
 * `slug` is one URL segment and is unique across *all* pages, not just among siblings. That is
 * what lets an old path keep resolving after a move: the last segment alone identifies the page.
 */
export interface NavPage {
  id: string;
  title: string;
  description: string;
  slug: string;
  /** `null` for a top-level page. */
  parentId: string | null;
  /** Position among its siblings, ascending, contiguous from zero. */
  order: number;
}

/** PATCH body for one nav page. A move sends `parentId` and `order` together. */
export interface NavPagePatch {
  title?: string;
  parentId?: string | null;
  order?: number;
}

/** Ids of the code-defined pages that can never be moved, nested, renamed or deleted. */
export const PINNED_PAGE_IDS = ['home', 'devops'] as const;
