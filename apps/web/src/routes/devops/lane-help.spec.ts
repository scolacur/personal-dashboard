import { describe, it, expect } from 'vitest';
import { TICKET_STATUSES } from '@dashboard/shared';
import { laneHelp, laneHelpText } from './lane-help';

describe('laneHelp', () => {
  it('covers every lane the board can show', () => {
    for (const status of TICKET_STATUSES) {
      const h = laneHelp(status);
      expect(h.summary.length).toBeGreaterThan(0);
    }
  });

  // The Queue is the whole point of the ticket: a card sitting in it is not necessarily going to
  // be picked up, and every reason it might not is a separate condition in `robotQueueCandidates`.
  // These assert the conditions are *present*, which is what stops one being dropped in an edit.
  it('states every Queue dispatch condition', () => {
    const text = laneHelpText('queue').toLowerCase();
    for (const condition of [
      'robot', // assignee = 'robot'
      'ready', // ready = 1 OR ready_bypassed = 1
      'bypass', // ready_bypassed
      'block', // the NOT EXISTS blocks-relation clause
      'repo', // p.github_repo IS NOT NULL
      'archiv', // t.archived_at IS NULL
      'agent state', // agent_state IS NULL OR 'queued'
    ]) {
      expect(text).toContain(condition);
    }
  });

  it('says the Queue arms rather than launches, which is the surprising part', () => {
    const text = laneHelpText('queue').toLowerCase();
    expect(text).toMatch(/armed|arms/);
    expect(text).toContain('concurrency');
  });

  it('gives the dispatch order, including both drag orders', () => {
    const text = laneHelpText('queue').toLowerCase();
    expect(text).toContain('priority');
    expect(text).toContain('epic');
    expect(text).toContain('drag order');
  });

  // D-080: a Ticket is not queued on its own; its Epic is what moves.
  it('tells Backlog readers that the Epic is what gets queued', () => {
    const text = laneHelpText('backlog').toLowerCase();
    expect(text).toContain('epic');
    expect(text).toMatch(/not by being dragged|on its own/);
  });

  // D-083: terminal is final.
  it('says both terminal lanes are read-only and how to leave them', () => {
    for (const status of ['completed', 'closed'] as const) {
      expect(laneHelpText(status).toLowerCase()).toContain('read-only');
      expect(laneHelpText(status).toLowerCase()).toContain('reopen');
    }
  });
});

describe('laneHelpText', () => {
  it('flattens summary, bullets and footnote into one block', () => {
    const h = laneHelp('backlog');
    const text = laneHelpText('backlog');
    expect(text.startsWith(h.summary)).toBe(true);
    for (const b of h.bullets) expect(text).toContain(b);
    if (h.footnote) expect(text.endsWith(h.footnote)).toBe(true);
  });
});
