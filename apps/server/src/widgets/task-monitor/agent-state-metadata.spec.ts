import { describe, it, expect } from 'vitest';
import {
  AGENT_STATE_LABELS,
  AGENT_STATE_DESCRIPTIONS,
  CHECKPOINT_CONTINUE_DEFAULT_TURNS,
  ROBOT_MAX_TURNS_LIMIT,
  resolveContinueTurns,
} from '@dashboard/shared';
import type { AgentState } from '@dashboard/shared';

const ALL_STATES: AgentState[] = [
  'queued',
  'working',
  'in-review',
  'stuck',
  'needs-human',
  'awaiting-human',
  // D-094 (PD-737): the turn-ceiling checkpoint.
  'checkpoint',
  'wontfix',
  'done',
];

describe('AGENT_STATE_LABELS', () => {
  it('has a non-empty label for every AgentState', () => {
    for (const state of ALL_STATES) {
      expect(AGENT_STATE_LABELS[state], `label for "${state}"`).toBeTruthy();
    }
  });

  it('covers every state', () => {
    expect(Object.keys(AGENT_STATE_LABELS)).toHaveLength(ALL_STATES.length);
  });
});

describe('AGENT_STATE_DESCRIPTIONS', () => {
  it('has a non-empty description for every AgentState', () => {
    for (const state of ALL_STATES) {
      expect(AGENT_STATE_DESCRIPTIONS[state], `description for "${state}"`).toBeTruthy();
    }
  });

  it('covers every state', () => {
    expect(Object.keys(AGENT_STATE_DESCRIPTIONS)).toHaveLength(ALL_STATES.length);
  });
});

// D-094 (PD-737): a Continue's extraTurns — default 50, 1–200, REJECTED above 200 (not clamped).
describe('resolveContinueTurns', () => {
  it('falls back to the default when unset', () => {
    expect(resolveContinueTurns(undefined)).toEqual({ ok: true, turns: CHECKPOINT_CONTINUE_DEFAULT_TURNS });
    expect(resolveContinueTurns(null)).toEqual({ ok: true, turns: CHECKPOINT_CONTINUE_DEFAULT_TURNS });
    expect(CHECKPOINT_CONTINUE_DEFAULT_TURNS).toBe(50);
  });

  it('accepts a value within bounds', () => {
    expect(resolveContinueTurns(1)).toEqual({ ok: true, turns: 1 });
    expect(resolveContinueTurns(80)).toEqual({ ok: true, turns: 80 });
    expect(resolveContinueTurns(ROBOT_MAX_TURNS_LIMIT)).toEqual({ ok: true, turns: ROBOT_MAX_TURNS_LIMIT });
  });

  it('rejects a value above the limit rather than clamping it (D-066)', () => {
    const r = resolveContinueTurns(ROBOT_MAX_TURNS_LIMIT + 1);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-integer or a value below 1', () => {
    expect(resolveContinueTurns(0).ok).toBe(false);
    expect(resolveContinueTurns(-5).ok).toBe(false);
    expect(resolveContinueTurns(3.5).ok).toBe(false);
  });
});
