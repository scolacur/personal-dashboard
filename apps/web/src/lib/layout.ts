import type { PageWidget } from '@dashboard/shared';
import type { WidgetMeta } from './widgets';

/**
 * Grid layout helpers (PD-331, reworked by PD-334/D-071).
 *
 * What used to live here — `loadPageLayout` / `savePageLayout` / `clearPageLayout` and the
 * registry-merge that backed them — is gone. That merge dropped saved ids absent from a page's
 * registry defaults and appended registry ids absent from the saved array, which made adding or
 * removing a widget structurally impossible; it existed so a widget registered later would show
 * up on pages already arranged. With placement now user state (D-071) there are no registry
 * defaults to merge against, and the server is the only store.
 *
 * `dashboard:layout:<pageId>` keys are cleared once, on first load, by `clearLegacyLayoutKeys`.
 */

const LEGACY_KEY_PREFIX = 'dashboard:layout:';

/** A placement paired with the registered widget it names. */
export interface ResolvedPlacement {
  widget: WidgetMeta;
  placement: PageWidget;
}

/**
 * Pair each placement with its widget, dropping any that name a widget the registry no longer
 * has. Same tolerance the old merge had: a stale row is ignored, never an error — the registry
 * is code and a row is data, and data outlives the code that made it.
 *
 * The registry is a **parameter, not an import**, which is not merely for testability: the web
 * vitest config runs without the Svelte plugin, so importing a *value* from `widgets.ts` would
 * pull in `.svelte` components and break this module's suite. `nav-utils.ts` carries the same
 * constraint, and the `loadPageLayout(pageId, defaults)` this replaces observed it too. A
 * type-only import is fine — it is erased.
 */
export function resolvePlacements(
  placements: PageWidget[],
  registry: WidgetMeta[],
): ResolvedPlacement[] {
  const byId = new Map(registry.map((w) => [w.id, w]));
  const resolved: ResolvedPlacement[] = [];
  for (const placement of placements) {
    const widget = byId.get(placement.widgetId);
    if (widget) resolved.push({ widget, placement });
  }
  return resolved;
}

/**
 * Remove the per-device layout keys D-053 wrote, once.
 *
 * Deliberately a delete and not a migration: the server seeds from the registry at boot, before
 * any browser connects, so importing a local layout would have to overwrite seeded rows — and
 * with two devices holding different local layouts, whichever loaded first would silently win
 * everywhere. Dropping them costs one re-arrange (D-071).
 */
export function clearLegacyLayoutKeys(): void {
  try {
    // Collect first, then remove: removing during iteration reindexes the store and would skip
    // every other key. Uses the `length`/`key(i)` Storage API rather than `Object.keys`, which
    // is not part of the Storage contract.
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_KEY_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // localStorage unavailable (private mode, disabled). Nothing to clean up, and nothing
    // downstream reads these keys any more.
  }
}
