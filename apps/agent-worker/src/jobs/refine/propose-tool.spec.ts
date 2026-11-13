import { describe, it, expect } from 'vitest';
import type { RefineProposal } from '@dashboard/shared';
import { validateProposalShape } from './propose-tool.js';

const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

describe('validateProposalShape', () => {
  it('rejects a decompose with no children key (the PD-273 slip)', () => {
    const p = { mode: 'decompose', rationale: 'too big' } as RefineProposal;
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('rejects a decompose with an empty children array', () => {
    const p: RefineProposal = { mode: 'decompose', children: [] };
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('accepts a decompose with children routed to a pre-queue lane', () => {
    const p: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' }],
    };
    expect(validateProposalShape(p)).toBeNull();
  });

  it('rejects a decompose child routed into a queue lane (D-057/D-058: Refine never queues)', () => {
    const robot: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'queue', assignee: 'robot' }],
    };
    expect(validateProposalShape(robot)).toMatch(/does not queue tickets/);
    const steve: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'queue', assignee: 'steve' }],
    };
    expect(validateProposalShape(steve)).toMatch(/does not queue tickets/);
  });

  it('rejects a legacy robot_queue/steve_queue child status (PD-417)', () => {
    const robot = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'robot_queue', assignee: 'robot' }],
    } as unknown as RefineProposal;
    expect(validateProposalShape(robot)).toMatch(/does not queue tickets/);
    const steve = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'steve_queue', assignee: 'steve' }],
    } as unknown as RefineProposal;
    expect(validateProposalShape(steve)).toMatch(/does not queue tickets/);
  });

  it('rejects a refine_in_place with no body', () => {
    const p: RefineProposal = { mode: 'refine_in_place', status: 'backlog' };
    expect(validateProposalShape(p)).toMatch(/refine_in_place requires the rewritten `body`/);
  });

  it('accepts a refine_in_place with a body (pre-queue lane or unset)', () => {
    expect(validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY })).toBeNull();
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'backlog' }),
    ).toBeNull();
  });

  it('rejects a refine_in_place routed into a queue lane (D-057/D-058)', () => {
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'queue' }),
    ).toMatch(/does not queue tickets/);
  });
});

describe('validateProposalShape — a Populate carries the Epic body (PD-634)', () => {
  const children = [{ title: 'c', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const }];

  it('rejects a decompose on an Epic with no body, telling the agent what to send', () => {
    expect(validateProposalShape({ mode: 'decompose', children }, { targetIsEpic: true })).toMatch(
      /Populate requires the Epic's rewritten `body`/,
    );
    expect(validateProposalShape({ mode: 'decompose', body: '  ', children }, { targetIsEpic: true })).toMatch(
      /rewritten `body`/,
    );
  });

  it('accepts a decompose on an Epic that carries the rewritten body', () => {
    expect(validateProposalShape({ mode: 'decompose', body: 'Reframed.', children }, { targetIsEpic: true })).toBeNull();
  });

  it('does not require a body for a split of an ordinary ticket', () => {
    expect(validateProposalShape({ mode: 'decompose', children }, { targetIsEpic: false })).toBeNull();
    expect(validateProposalShape({ mode: 'decompose', children })).toBeNull();
  });

  it('accepts a child that opts out of being born refined', () => {
    const p: RefineProposal = { mode: 'decompose', children: [{ ...children[0], refined: false }] };
    expect(validateProposalShape(p)).toBeNull();
  });
});
