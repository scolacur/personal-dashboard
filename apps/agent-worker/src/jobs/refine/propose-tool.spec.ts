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
      children: [{ title: 'c', body: ROBOT_BODY, status: 'prioritized', assignee: 'robot' }],
    };
    expect(validateProposalShape(p)).toBeNull();
  });

  it('rejects a decompose child routed into a queue lane (D-057: Refine never queues)', () => {
    const robot: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'robot_queue', assignee: 'robot' }],
    };
    expect(validateProposalShape(robot)).toMatch(/does not queue tickets/);
    const steve: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'steve_queue', assignee: 'steve' }],
    };
    expect(validateProposalShape(steve)).toMatch(/does not queue tickets/);
  });

  it('rejects a refine_in_place with no body', () => {
    const p: RefineProposal = { mode: 'refine_in_place', status: 'prioritized' };
    expect(validateProposalShape(p)).toMatch(/refine_in_place requires the rewritten `body`/);
  });

  it('accepts a refine_in_place with a body (pre-queue lane or unset)', () => {
    expect(validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY })).toBeNull();
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'prioritized' }),
    ).toBeNull();
  });

  it('rejects a refine_in_place routed into a queue lane (D-057)', () => {
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'robot_queue' }),
    ).toMatch(/does not queue tickets/);
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'steve_queue' }),
    ).toMatch(/does not queue tickets/);
  });
});
