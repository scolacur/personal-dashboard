import { describe, it, expect } from 'vitest';
import type { RefineProposal } from '@dashboard/shared';
import {
  approvedMessage,
  childBornRefined,
  proposalCanQueue,
  proposalDetailsSummary,
  proposalModeLabel,
  proposalNotReady,
} from './refine-proposal-logic';

const READY = '## Context\nc\n\n## Task\nt\n\n## Done When\nd\n\n## Out of scope\no';
const inPlace: RefineProposal = { mode: 'refine_in_place', body: READY };
const split: RefineProposal = {
  mode: 'decompose',
  children: [
    { title: 'a', body: 'x', status: 'backlog', assignee: 'steve' },
    { title: 'b', body: 'y', status: 'backlog', assignee: 'steve' },
  ],
};

describe('refine proposal card helpers (PD-843)', () => {
  it('labels the mode, a decompose of an Epic being a Populate', () => {
    expect(proposalModeLabel(inPlace, false)).toBe('Refine in place');
    expect(proposalModeLabel(split, false)).toBe('Split');
    expect(proposalModeLabel(split, true)).toBe('Populate');
  });

  it('offers Approve & queue only for a non-Epic refine in place', () => {
    expect(proposalCanQueue(inPlace, false)).toBe(true);
    expect(proposalCanQueue(inPlace, true)).toBe(false);
    expect(proposalCanQueue(split, false)).toBe(false);
  });

  it('flags a refine-in-place body that is not Ready-shaped', () => {
    expect(proposalNotReady(inPlace)).toBe(false);
    expect(proposalNotReady({ mode: 'refine_in_place', body: 'loose notes' })).toBe(true);
    expect(proposalNotReady(split)).toBe(false);
  });

  it('marks a robot child with a non-Ready body, or an opted-out child, as not born refined', () => {
    expect(childBornRefined({ title: 't', body: 'x', status: 'backlog', assignee: 'steve' })).toBe(true);
    expect(childBornRefined({ title: 't', body: 'x', status: 'backlog', assignee: 'robot' })).toBe(false);
    expect(childBornRefined({ title: 't', body: READY, status: 'backlog', assignee: 'robot' })).toBe(true);
    expect(childBornRefined({ title: 't', body: READY, status: 'backlog', assignee: 'steve', refined: false })).toBe(false);
  });

  it('summarises what a collapsed proposal holds', () => {
    expect(proposalDetailsSummary(inPlace, false)).toBe('Proposed body');
    expect(proposalDetailsSummary(split, false)).toBe('2 proposed tickets');
    expect(proposalDetailsSummary({ ...split, children: [split.children![0]] }, false)).toBe('1 proposed ticket');
    expect(proposalDetailsSummary({ ...split, body: 'epic' }, true)).toBe('Epic description and 2 proposed members');
    expect(proposalDetailsSummary(split, true)).toBe('2 proposed members');
  });

  it('words the approval by what the server did', () => {
    expect(approvedMessage({ queued: false, populated: true })).toMatch(/members created/);
    expect(approvedMessage({ queued: true, populated: false })).toMatch(/queued/);
    expect(approvedMessage({ queued: false, populated: false })).toMatch(/^Approved\. Drag/);
  });
});
