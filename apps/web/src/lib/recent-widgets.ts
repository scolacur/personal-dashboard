import type { WidgetUsage } from '@dashboard/shared';

/**
 * Pure logic behind "Home shows recently used widgets" (PD-751).
 *
 * **What counts as a use:**
 * - visiting a widget's own route (`/widgets/<id>`, or a Dev Ops summary's page), including any
 *   sub-path of it;
 * - interacting with a widget's card (pointerdown / focusin inside it) on any page **except
 *   Home**.
 *
 * **Why Home never records:** Home *is* the recent list. If touching a card there counted, the
 * widgets already on Home would keep refreshing themselves and nothing used elsewhere could ever
 * displace them — the list would reinforce itself instead of reflecting what you actually use.
 *
 * Kept free of `widgets.ts` value imports (the registry is a parameter) so the web vitest config,
 * which has no Svelte plugin, can run this module's spec — the same constraint as `layout.ts`
 * and `nav-utils.ts`.
 */

/** How many widgets Home shows at most. */
export const RECENT_WIDGETS_CAP = 8;

/** At most one recorded use per widget per this window, per tab. */
export const USE_THROTTLE_MS = 60_000;

/** The Home route. Uses are never recorded here (see the module comment). */
export const HOME_ROUTE = '/';

/**
 * The ids Home should show: most recently used first, only widgets still in the registry,
 * no duplicates, at most `cap`. An empty result means "no usage yet" — the caller falls back to
 * the curated Home grid.
 */
export function recentWidgetIds(
  usage: WidgetUsage[],
  registryIds: Iterable<string>,
  cap: number = RECENT_WIDGETS_CAP,
): string[] {
  const known = new Set(registryIds);
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...usage].sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt || a.widgetId.localeCompare(b.widgetId),
  );
  for (const u of sorted) {
    if (out.length >= cap) break;
    if (!known.has(u.widgetId) || seen.has(u.widgetId)) continue;
    seen.add(u.widgetId);
    out.push(u.widgetId);
  }
  return out;
}

/** Whether a use observed at `pathname` should be recorded at all. */
export function shouldRecordUseAt(pathname: string): boolean {
  return pathname !== HOME_ROUTE;
}

/**
 * The widget whose own page `pathname` is, or `undefined`. Matches the route exactly or as a
 * prefix at a path boundary (`/widgets/diary/2026` is still Diary); the longest route wins so a
 * nested route can never be claimed by a shorter one.
 */
export function widgetIdForPath(
  pathname: string,
  routes: { id: string; route: string }[],
): string | undefined {
  let best: { id: string; route: string } | undefined;
  for (const r of routes) {
    if (r.route === HOME_ROUTE) continue;
    const hit = pathname === r.route || pathname.startsWith(r.route + '/');
    if (hit && (!best || r.route.length > best.route.length)) best = r;
  }
  return best?.id;
}

/**
 * A per-key throttle: `shouldSend(id)` is true at most once per `windowMs` for each id. The
 * clock is injectable so the spec needs no fake timers.
 */
export function createUseThrottle(
  windowMs: number = USE_THROTTLE_MS,
  now: () => number = Date.now,
): { shouldSend(id: string): boolean } {
  const lastSent = new Map<string, number>();
  return {
    shouldSend(id: string): boolean {
      const t = now();
      const prev = lastSent.get(id);
      if (prev !== undefined && t - prev < windowMs) return false;
      lastSent.set(id, t);
      return true;
    },
  };
}
