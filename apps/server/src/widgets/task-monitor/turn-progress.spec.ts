import { describe, it, expect } from 'vitest';
import {
  ROBOT_MAX_TURNS_DEFAULT,
  showsTurnProgress,
  turnProgress,
  TURN_PROGRESS_STATES,
} from '@dashboard/shared';

/**
 * PD-230 — turn progress toward the per-run cap, shown inside the Robot status pill.
 * The helpers live in `packages/shared` (consumed by the board card); `packages/shared` has no
 * vitest setup of its own yet (PD-2), so like `is-ready.spec.ts` they are covered from here.
 */

describe('turnProgress', () => {
  it('formats turns against the default ceiling', () => {
    const p = turnProgress(12);
    expect(p).not.toBeNull();
    expect(p?.turns).toBe(12);
    expect(p?.max).toBe(ROBOT_MAX_TURNS_DEFAULT);
    expect(p?.label).toBe(`12/${ROBOT_MAX_TURNS_DEFAULT}`);
    expect(p?.nearCap).toBe(false);
    expect(p?.atCap).toBe(false);
  });

  it('returns null when there is no usable count', () => {
    expect(turnProgress(null)).toBeNull();
    expect(turnProgress(undefined)).toBeNull();
    expect(turnProgress(0)).toBeNull(); // a run that has not taken a turn yet shows nothing
    expect(turnProgress(-3)).toBeNull();
    expect(turnProgress(Number.NaN)).toBeNull();
  });

  it('flags nearCap at 80% of the ceiling and above', () => {
    expect(turnProgress(39, 50)?.nearCap).toBe(false);
    expect(turnProgress(40, 50)?.nearCap).toBe(true); // exactly 80%
    expect(turnProgress(43, 50)?.nearCap).toBe(true); // PD-420 run #15
  });

  it('flags atCap only at/over the ceiling', () => {
    expect(turnProgress(49, 50)?.atCap).toBe(false);
    expect(turnProgress(50, 50)?.atCap).toBe(true); // PD-420 run #16
  });

  it('does NOT clamp a count past the ceiling — "51/50" is the honest, diagnostic form', () => {
    // PD-412 run #12 really did record 51 turns against a cap of 50.
    const p = turnProgress(51, 50);
    expect(p?.label).toBe('51/50');
    expect(p?.atCap).toBe(true);
  });

  it('falls back to the default ceiling when given a nonsense max', () => {
    expect(turnProgress(5, 0)?.max).toBe(ROBOT_MAX_TURNS_DEFAULT);
    expect(turnProgress(5, -1)?.max).toBe(ROBOT_MAX_TURNS_DEFAULT);
    expect(turnProgress(5, Number.NaN)?.max).toBe(ROBOT_MAX_TURNS_DEFAULT);
  });
});

describe('showsTurnProgress', () => {
  it('shows for the states where turn budget is meaningful', () => {
    expect(showsTurnProgress('working', 12)).toBe(true);
    expect(showsTurnProgress('in-review', 30)).toBe(true);
    // `stuck` is where the cap actually bites — a card reading 50/50 explains itself.
    expect(showsTurnProgress('stuck', 50)).toBe(true);
    expect(TURN_PROGRESS_STATES).toEqual(['working', 'in-review', 'stuck']);
  });

  it('hides for states where a turn count would be noise', () => {
    expect(showsTurnProgress('queued', 12)).toBe(false); // not started
    expect(showsTurnProgress('done', 12)).toBe(false); // terminal
    expect(showsTurnProgress('wontfix', 12)).toBe(false);
    expect(showsTurnProgress('awaiting-human', 12)).toBe(false);
    expect(showsTurnProgress('needs-human', 12)).toBe(false);
  });

  it('hides when there is no agent state or no count', () => {
    expect(showsTurnProgress(null, 12)).toBe(false);
    expect(showsTurnProgress('working', null)).toBe(false);
    expect(showsTurnProgress('working', 0)).toBe(false);
  });
});
