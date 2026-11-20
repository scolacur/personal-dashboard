import { VISUAL_CAPTURE_ENV, type AwaitingVisualItem } from '@dashboard/shared';

/**
 * The visual-check card's decisions (PD-773), out of the component because `apps/web` has no
 * component tests.
 */

export type Shot = AwaitingVisualItem['shots'][number];

/**
 * Shots grouped by page and step (PD-798) in capture order: the page as it loaded, then the result of
 * each click step. Within a group, a fixed viewport × scheme order. `heading` names the group:
 * `/widgets/habit-tracker`, then `/widgets/habit-tracker › click "Habits"`.
 */
export function shotsByRoute(shots: readonly Shot[]): { route: string; heading: string; key: string; shots: Shot[] }[] {
  const order = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'];
  const groups: { route: string; heading: string; key: string; idx: number; shots: Shot[] }[] = [];
  const routes: string[] = [];
  for (const s of shots) {
    if (!routes.includes(s.route)) routes.push(s.route);
    const idx = s.stepIndex ?? 0;
    const key = `${s.route}#${idx}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { route: s.route, heading: idx === 0 ? s.route : `${s.route} › ${s.step ?? `step ${idx}`}`, key, idx, shots: [] };
      groups.push(g);
    }
    g.shots.push(s);
  }
  groups.sort((a, b) => routes.indexOf(a.route) - routes.indexOf(b.route) || a.idx - b.idx);
  return groups.map(({ route, heading, key, shots: gs }) => ({
    route,
    heading,
    key,
    shots: [...gs].sort((a, b) => order.indexOf(`${a.viewport}-${a.scheme}`) - order.indexOf(`${b.viewport}-${b.scheme}`)),
  }));
}

/** The click steps that could not run, as the card lists them (PD-798). */
export function stepFailureLines(item: Pick<AwaitingVisualItem, 'stepFailures'>): string[] {
  return (item.stepFailures ?? []).map((f) => `${f.route} › ${f.step}: ${f.reason}`);
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

/** "4 min", "2 h 5 min", "just now": how long something has been waiting. */
export function waitedFor(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/**
 * What the card says about capture for the PR's current head (PD-794), or null when the screenshots
 * speak for themselves. Every state says what is really happening; none falls back to "still being
 * captured" unless capture is on and this head is actually queued.
 */
export function captureNotice(
  item: Pick<AwaitingVisualItem, 'capture' | 'shots'>,
  now: number,
): { tone: 'info' | 'warn'; text: string } | null {
  const c = item.capture;
  switch (c.kind) {
    case 'captured':
      return item.shots.length > 0 ? null : { tone: 'warn', text: 'Capture finished, but recorded no screenshots for this head.' };
    case 'capturing':
      return { tone: 'info', text: `Capture is on and this head is queued for screenshots (waiting ${waitedFor(now - c.since)}).` };
    case 'off':
      return {
        tone: 'warn',
        text: `Capture is off: ${VISUAL_CAPTURE_ENV} is not set on the worker, so no screenshots are coming. This PR is not held for your check; judge it from the PR itself.`,
      };
    case 'failed':
      return { tone: 'warn', text: `Capture failed for this head: ${c.reason}` };
    case 'skipped':
      return { tone: 'info', text: `Capture skipped for this head: ${c.reason}.` };
    case 'unknown':
      return {
        tone: 'warn',
        text:
          c.lastSeen === null
            ? 'Capture state unknown: the worker has not reported whether capture is on.'
            : `Capture state unknown: the worker last reported ${waitedFor(now - c.lastSeen)} ago.`,
      };
  }
}
