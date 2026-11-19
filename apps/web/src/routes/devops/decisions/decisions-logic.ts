// Pure helpers for the Decisions inbox (PD-746). Kept out of the page so they are unit-testable
// (apps/web's vitest cannot import .svelte).

/** "just now", "12m ago", "3h ago", "2d ago". Clamps a future timestamp to "just now". */
export function askedAgo(askedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - askedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
