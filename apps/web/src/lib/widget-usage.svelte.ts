import type { WidgetUsage } from '@dashboard/shared';
import { createUseThrottle, shouldRecordUseAt } from './recent-widgets';

/**
 * Client side of widget usage (PD-751, Home shows recently used widgets).
 *
 * The rules — what counts as a use, the throttle, Home never recording — live in the pure
 * `recent-widgets.ts`, which is where they are tested. This module is only the wiring: the
 * fetches, and the one bit of shared state Home exposes to the top nav.
 */

const BASE = '/api/shell/widget-usage';

const throttle = createUseThrottle();

/**
 * What Home is currently showing. The top nav reads this to decide whether Arrange applies on
 * `/`: only the curated grid is arrangeable. The recent view is derived from usage — there is no
 * stored arrangement to edit, and dragging a card would be undone by the next use anyway.
 * `'pending'` until Home has heard back, so the Arrange button never flashes on and then off.
 */
export type HomeView = 'pending' | 'recent' | 'curated';

let _homeView = $state<HomeView>('pending');

export const homeView = {
  get current(): HomeView {
    return _homeView;
  },
  set(view: HomeView): void {
    _homeView = view;
  },
};

/**
 * Record a use of `widgetId` observed at `pathname`. Fire-and-forget: usage is a hint for Home,
 * not user data, so a failed POST is dropped silently rather than raising a toast on every click.
 */
export function recordWidgetUse(widgetId: string, pathname: string): void {
  if (!shouldRecordUseAt(pathname)) return;
  if (!throttle.shouldSend(widgetId)) return;
  void fetch(`${BASE}/${encodeURIComponent(widgetId)}`, { method: 'POST' }).catch(() => {});
}

/** Usage rows, most recent first. Throws on failure so Home can fall back to the curated grid. */
export async function fetchWidgetUsage(): Promise<WidgetUsage[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`widget usage: ${res.status}`);
  return (await res.json()) as WidgetUsage[];
}
