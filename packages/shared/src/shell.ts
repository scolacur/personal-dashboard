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
 * How recently and how often a widget has been used (PD-751, Home shows recently used widgets).
 *
 * Server-side so "recent" is the same on every device. A "use" is a visit to the widget's own
 * route or an interaction with its card on any page other than Home; see `recent-widgets.ts`.
 */
export interface WidgetUsage {
  widgetId: string;
  /** Unix ms of the most recent recorded use. */
  lastUsedAt: number;
  /** Recorded uses (after the client's throttle), all time. */
  useCount: number;
}
