import type { WidgetMeta } from './widgets';

export interface WidgetLayout {
  id: string;
  order: number;
  cols: number;
  rows: number;
}

const KEY_PREFIX = 'dashboard:layout:';

export function defaultLayout(defaults: WidgetMeta[]): WidgetLayout[] {
  return defaults.map((d, i) => ({
    id: d.id,
    order: i,
    cols: d.embed?.span.cols ?? 1,
    rows: d.embed?.span.rows ?? 1,
  }));
}

/**
 * Load persisted layout for a page, merged with registry defaults.
 * - Saved ids absent from defaults are ignored (stale/removed widgets).
 * - Registry ids absent from saved are appended at the end in registry order.
 */
export function loadPageLayout(pageId: string, defaults: WidgetMeta[]): WidgetLayout[] {
  let saved: WidgetLayout[] = [];
  try {
    const raw = localStorage.getItem(KEY_PREFIX + pageId);
    if (raw) saved = JSON.parse(raw) as WidgetLayout[];
  } catch {
    // ignore parse errors or unavailable localStorage
  }

  if (saved.length === 0) return defaultLayout(defaults);

  const knownIds = new Set(defaults.map((d) => d.id));
  const validSaved = saved
    .filter((s) => knownIds.has(s.id))
    .sort((a, b) => a.order - b.order);
  const savedIds = new Set(validSaved.map((s) => s.id));

  const appended = defaults
    .filter((d) => !savedIds.has(d.id))
    .map((d, i) => ({
      id: d.id,
      order: validSaved.length + i,
      cols: d.embed?.span.cols ?? 1,
      rows: d.embed?.span.rows ?? 1,
    }));

  return [...validSaved, ...appended];
}

export function savePageLayout(pageId: string, layouts: WidgetLayout[]): void {
  try {
    localStorage.setItem(KEY_PREFIX + pageId, JSON.stringify(layouts));
  } catch {
    // ignore
  }
}

export function clearPageLayout(pageId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + pageId);
  } catch {
    // ignore
  }
}
