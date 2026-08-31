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

  // The Epic is the unit of dispatch (D-TMP-PD383a): you move the Epic, its tickets follow. And
  // being queued is not the same as being picked up — the concurrency cap is the reason a queued
  // ticket can sit still, which is the question the lane header gets asked.
  it('says you move the Epic, and that the concurrency cap gates pickup', () => {
    const text = laneHelpText('queue').toLowerCase();
    expect(text).toContain('epic');
    expect(text).toMatch(/queued automatically|its tickets/);
    expect(text).toContain('concurrent');
  });

  it('gives the dispatch order, including both drag orders', () => {
    const text = laneHelpText('queue').toLowerCase();
    expect(text).toContain('priority');
    expect(text).toContain('epic');
    expect(text).toContain('drag order');
  });

  // D-039 is the load-bearing claim: an autonomous agent may only ever create into Backlog. The
  // other half is where things ARRIVE — a member added to a live Epic, and a reopened ticket.
  it('states the agent-create rule and what lands here', () => {
    const text = laneHelpText('backlog').toLowerCase();
    expect(text).toContain('autonomous agents');
    expect(text).toMatch(/only ever create/);
    expect(text).toContain('reopened');
    expect(text).toContain('epic');
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
