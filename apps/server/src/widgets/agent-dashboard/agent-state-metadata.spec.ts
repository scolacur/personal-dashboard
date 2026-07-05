import { describe, it, expect } from 'vitest';
import { AGENT_STATE_LABELS, AGENT_STATE_DESCRIPTIONS } from '@dashboard/shared';
import type { AgentState } from '@dashboard/shared';

const ALL_STATES: AgentState[] = [
  'queued',
  'working',
  'in-review',
  'stuck',
  'needs-human',
  'awaiting-human',
  'wontfix',
  'done',
];

describe('AGENT_STATE_LABELS', () => {
  it('has a non-empty label for every AgentState', () => {
    for (const state of ALL_STATES) {
      expect(AGENT_STATE_LABELS[state], `label for "${state}"`).toBeTruthy();
    }
  });

  it('covers all 8 states', () => {
    expect(Object.keys(AGENT_STATE_LABELS)).toHaveLength(ALL_STATES.length);
  });
});

describe('AGENT_STATE_DESCRIPTIONS', () => {
  it('has a non-empty description for every AgentState', () => {
    for (const state of ALL_STATES) {
      expect(AGENT_STATE_DESCRIPTIONS[state], `description for "${state}"`).toBeTruthy();
    }
  });

  it('covers all 8 states', () => {
    expect(Object.keys(AGENT_STATE_DESCRIPTIONS)).toHaveLength(ALL_STATES.length);
  });
});
