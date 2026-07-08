import { describe, it, expect } from 'vitest';
import type { RefineProposal } from '@dashboard/shared';
import { validateProposalShape } from './propose-tool.js';

const SORTIE_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

describe('validateProposalShape', () => {
  it('rejects a decompose with no children key (the PD-273 slip)', () => {
    const p = { mode: 'decompose', rationale: 'too big' } as RefineProposal;
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('rejects a decompose with an empty children array', () => {
    const p: RefineProposal = { mode: 'decompose', children: [] };
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('accepts a decompose with children', () => {
    const p: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: SORTIE_BODY, status: 'robot_queue', assignee: 'robot' }],
    };
    expect(validateProposalShape(p)).toBeNull();
  });

  it('rejects a refine_in_place with no body', () => {
    const p: RefineProposal = { mode: 'refine_in_place', status: 'prioritized' };
    expect(validateProposalShape(p)).toMatch(/refine_in_place requires the rewritten `body`/);
  });

  it('accepts a refine_in_place with a body', () => {
    const p: RefineProposal = { mode: 'refine_in_place', body: SORTIE_BODY };
    expect(validateProposalShape(p)).toBeNull();
  });
});
