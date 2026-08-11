import { pages } from './pages';

/** The Library page's route and nav label (PD-334, D-071).
 *
 *  Deliberately absent from `pages.ts` — it is a derived view, not a curated page, and keeping
 *  it out is what stops `arrangeablePageId` ever lighting up the Arrange button there. The cost
 *  is that title resolution needs this one explicit case.
 *
 *  Term and label differ on purpose: **library** is the domain word used in code and docs,
 *  **All Widgets** is the button copy, because "Library" alone reads vaguely in a nav sitting
 *  beside "New Page" and "Edit". */
export const LIBRARY_ROUTE = '/library';
export const LIBRARY_TITLE = 'All Widgets';

/** Returns the title of the nav page that best matches `pathname`, or "Dashboard" if none. */
export function resolvePageTitle(pathname: string): string {
  if (pathname === LIBRARY_ROUTE) return LIBRARY_TITLE;

  // Sort longest route first so /devops/tickets/... matches /devops before /.
  const sorted = [...pages].sort((a, b) => b.route.length - a.route.length);
  const match = sorted.find((p) =>
    p.route === '/'
      ? pathname === '/'
      : pathname === p.route || pathname.startsWith(p.route + '/'),
  );
  return match?.title ?? 'Dashboard';
}

/**
 * The id of the nav page whose widget grid `pathname` renders, or `undefined` when the
 * route isn't a widget grid at all. Callers pair this with the widget registry to decide
 * whether the top-nav Arrange button applies.
 *
 * Exact route match, deliberately: a *subroute* of a widget-bearing page is its own view,
 * not that page's grid. `/devops` is an Arrange-able grid (PD-413) while
 * `/devops/task-tracker` is the Kanban and `/devops/jobs` is a plain list — a `startsWith`
 * match would light the button up on all three and arrange nothing.
 *
 * Kept free of any `widgets.ts` import so this module stays pure TS: the web vitest config
 * runs without the Svelte plugin, so a transitive `.svelte` import would break the suite.
 */
export function arrangeablePageId(pathname: string): string | undefined {
  return pages.find((pg) => pg.route === pathname)?.id;
}

/**
 * Whether `pathname` is anywhere under Dev Ops. Drives the deploy/commit readout in the top
 * nav (PD-414), which belongs on the whole section.
 *
 * A **prefix** match, deliberately unlike `arrangeablePageId`'s exact one — the two answer
 * different questions and must not be unified. Deploy state is section-wide context; Arrange
 * applies only to the single route that actually renders a widget grid.
 */
export function isDevOpsRoute(pathname: string): boolean {
  return pathname === '/devops' || pathname.startsWith('/devops/');
}
