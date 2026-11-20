import type { AwaitingVisualItem } from '@dashboard/shared';

/**
 * The visual-check card's decisions (PD-773), out of the component because `apps/web` has no
 * component tests.
 */

export type Shot = AwaitingVisualItem['shots'][number];

/** Shots grouped by route, in a fixed viewport × scheme order, for a grid per page. */
export function shotsByRoute(shots: readonly Shot[]): { route: string; shots: Shot[] }[] {
  const order = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'];
  const routes: string[] = [];
  for (const s of shots) if (!routes.includes(s.route)) routes.push(s.route);
  return routes.map((route) => ({
    route,
    shots: shots
      .filter((s) => s.route === route)
      .sort((a, b) => order.indexOf(`${a.viewport}-${a.scheme}`) - order.indexOf(`${b.viewport}-${b.scheme}`)),
  }));
}

/** Why Request changes is not allowed yet, or null when it is: a rejection must say what to change. */
export function rejectBlocked(note: string): string | null {
  return note.trim() === '' ? 'Say what to change; the Robot reworks from your note.' : null;
}

/** "the Robot" / "the Evaluator" asked, with what to look at. */
export function askedBy(item: Pick<AwaitingVisualItem, 'reasons'>): string {
  const who = [...new Set(item.reasons.map((r) => (r.by === 'evaluator' ? 'the Evaluator' : 'the Robot')))];
  return who.join(' and ');
}
