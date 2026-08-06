// Persisted open/closed state for collapsible sections.
//
// Extracted from Collapsible.svelte when ListManager grew its own collapsible header (PD-475) —
// two components hand-rolling the same localStorage dance is how they drift apart.

/**
 * The storage prefix. Reads `tm.` (task monitor) because that is where the first collapsible
 * shipped, and **changing it would silently reset every section a user has already closed**.
 * It is a namespace, not a claim about who may use it.
 */
const PREFIX = 'tm.collapsible.';

/** Whether a section should start open. `storeKey` undefined means "don't persist". */
export function readOpen(storeKey: string | undefined, fallback: boolean): boolean {
  // Guarded rather than assumed: this runs during SSR under `vite dev`, where there is no
  // localStorage at all.
  if (!storeKey || typeof localStorage === 'undefined') return fallback;
  const v = localStorage.getItem(PREFIX + storeKey);
  return v === null ? fallback : v === '1';
}

export function writeOpen(storeKey: string | undefined, open: boolean): void {
  if (!storeKey || typeof localStorage === 'undefined') return;
  localStorage.setItem(PREFIX + storeKey, open ? '1' : '0');
}
