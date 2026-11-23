import { describe, it, expect } from 'vitest';
import type { ActiveAgent } from '@dashboard/shared';
import { ACTIVE_REFRESH_MS, REFRESH_MS, nextPollDelay } from './system-status-view';

const agent = { kind: 'robot', runId: 1 } as ActiveAgent;

describe('nextPollDelay (PD-908)', () => {
  it('polls fast while any agent is active', () => {
    expect(nextPollDelay({ activeAgents: [agent] }, false)).toBe(ACTIVE_REFRESH_MS);
  });

  it('falls back to the idle rate with no active agents, before the first response, or from an older server', () => {
    expect(nextPollDelay({ activeAgents: [] }, false)).toBe(REFRESH_MS);
    expect(nextPollDelay(null, false)).toBe(REFRESH_MS);
    expect(nextPollDelay({}, false)).toBe(REFRESH_MS);
  });

  it('does not poll at all while the tab is hidden', () => {
    expect(nextPollDelay({ activeAgents: [agent] }, true)).toBeNull();
    expect(nextPollDelay(null, true)).toBeNull();
  });

  it('is meaningfully faster when active', () => {
    expect(ACTIVE_REFRESH_MS).toBeLessThan(REFRESH_MS);
  });
});
