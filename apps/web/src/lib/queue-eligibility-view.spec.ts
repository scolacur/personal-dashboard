import { describe, it, expect } from 'vitest';
import type {
  AgentTicket,
  AutoQueueCapacity,
  AutoQueueCriterion,
  AutoQueueEligibility,
  AutoQueueEpicEligibility,
  AutoQueueMode,
  AutoQueueVerdict,
  TicketAssignee,
} from '@dashboard/shared';
import { buildChecklistView, capacityWaitFor } from './queue-eligibility-view';

// D-103 (PD-809): the pure view model behind the auto-queue checklist. Every verdict, the muted
// mode note, the capacity-visibility rule, remedy links and the Epic roll-up are reachable here —
// apps/web has no DOM test runner, so the derivation lives in a plain module tested like any other.

function crit(id: string, met: boolean, extra: Partial<AutoQueueCriterion> = {}): AutoQueueCriterion {
  return { id: id as AutoQueueCriterion['id'], label: id, description: '', met, ...extra };
}

const capacity: AutoQueueCapacity = {
  ok: false,
  rows: [
    { id: 'queue-depth', label: 'Queue depth', description: '', current: 1, limit: 2, met: true },
    {
      id: 'review-wip',
      label: 'Review WIP',
      description: '',
      current: 3,
      limit: 3,
      met: false,
      reason: 'Too many robot PRs are already awaiting review.',
    },
    { id: 'epic-in-flight', label: 'Epic in flight', description: '', current: 0, limit: 1, met: true },
    { id: 'worker-healthy', label: 'Worker healthy', description: '', current: 0, limit: 1, met: true },
  ],
};

function ticketView(opts: {
  verdict: AutoQueueVerdict;
  assignee?: TicketAssignee | null;
  mode?: AutoQueueMode;
  criteria?: AutoQueueCriterion[];
}) {
  const eligibility: AutoQueueEligibility = {
    verdict: opts.verdict,
    criteria: opts.criteria ?? [crit('refined', true), crit('ready', false, { reason: 'missing "## Out of scope"' })],
  };
  return buildChecklistView({
    isEpic: false,
    assignee: opts.assignee ?? 'robot',
    mode: opts.mode ?? 'on',
    eligibility,
    capacity,
    ticketHref: () => null,
  });
}

describe('buildChecklistView — verdict wording', () => {
  it('eligible', () => {
    expect(ticketView({ verdict: 'eligible' }).verdictLine).toBe('Will auto-queue when capacity allows');
  });
  it('not-eligible counts the unmet criteria', () => {
    const v = ticketView({
      verdict: 'not-eligible',
      criteria: [crit('a', false), crit('b', false), crit('c', true)],
    });
    expect(v.verdictLine).toBe('Not eligible — 2 unmet');
  });
  it('in-queue', () => {
    expect(ticketView({ verdict: 'in-queue' }).verdictLine).toBe('In the Queue');
  });
  it('terminal', () => {
    expect(ticketView({ verdict: 'terminal' }).verdictLine).toBe('Completed/Closed — not applicable');
  });
  it('human-work splits steve from unassigned', () => {
    expect(ticketView({ verdict: 'human-work', assignee: 'steve' }).verdictLine).toBe(
      'Not auto-queued — assigned to steve (human work is never automated)',
    );
    expect(ticketView({ verdict: 'human-work', assignee: null }).verdictLine).toBe(
      'Not auto-queued — no assignee',
    );
  });
});

describe('buildChecklistView — mode note', () => {
  it('off', () => {
    expect(ticketView({ verdict: 'eligible', mode: 'off' }).modeNote).toBe(
      'Auto-queue is off — nothing is promoted automatically.',
    );
  });
  it('dry-run', () => {
    expect(ticketView({ verdict: 'eligible', mode: 'dry-run' }).modeNote).toBe(
      'Auto-queue is in dry-run — promotions are logged, not applied.',
    );
  });
  it('on — no note', () => {
    expect(ticketView({ verdict: 'eligible', mode: 'on' }).modeNote).toBeNull();
  });
});

describe('buildChecklistView — criteria rows', () => {
  it('marks met/unmet and carries the reason only when unmet', () => {
    const v = ticketView({ verdict: 'not-eligible' });
    const refined = v.criteria.find((c) => c.id === 'refined')!;
    const ready = v.criteria.find((c) => c.id === 'ready')!;
    expect(refined.mark).toBe('✓');
    expect(refined.reason).toBeUndefined();
    expect(ready.mark).toBe('✗');
    expect(ready.reason).toBe('missing "## Out of scope"');
  });

  it('links an unmet criterion to its remedy when resolvable', () => {
    const v = buildChecklistView({
      isEpic: false,
      assignee: 'robot',
      mode: 'on',
      eligibility: {
        verdict: 'not-eligible',
        criteria: [crit('epic-active', false, { reason: 'Its Epic is not active.', remedy: { kind: 'open-epic', ticketId: 42 } })],
      },
      capacity,
      ticketHref: (id) => (id === 42 ? '/devops/tickets/PD-42' : null),
    });
    expect(v.criteria[0].href).toBe('/devops/tickets/PD-42');
  });

  it('omits the link when the remedy does not resolve (e.g. self)', () => {
    const v = buildChecklistView({
      isEpic: false,
      assignee: 'robot',
      mode: 'on',
      eligibility: {
        verdict: 'not-eligible',
        criteria: [crit('epic-active', false, { reason: 'x', remedy: { kind: 'open-epic', ticketId: 1 } })],
      },
      capacity,
      ticketHref: () => null,
    });
    expect(v.criteria[0].href).toBeUndefined();
  });
});

describe('buildChecklistView — capacity visibility', () => {
  it('shows capacity for eligible and not-eligible', () => {
    expect(ticketView({ verdict: 'eligible' }).showCapacity).toBe(true);
    expect(ticketView({ verdict: 'not-eligible' }).showCapacity).toBe(true);
  });
  it('hides capacity for in-queue, terminal and human work', () => {
    expect(ticketView({ verdict: 'in-queue' }).showCapacity).toBe(false);
    expect(ticketView({ verdict: 'terminal' }).showCapacity).toBe(false);
    expect(ticketView({ verdict: 'human-work', assignee: 'steve' }).showCapacity).toBe(false);
  });
  it('formats count limbs but not the health limb', () => {
    const rows = ticketView({ verdict: 'not-eligible' }).capacity;
    expect(rows.find((r) => r.id === 'queue-depth')!.label).toBe('Queue depth 1 / 2');
    expect(rows.find((r) => r.id === 'review-wip')!.mark).toBe('✗');
    expect(rows.find((r) => r.id === 'worker-healthy')!.label).toBe('Worker healthy');
  });
});

describe('capacityWaitFor — the board Eligible view capacity note (PD-810)', () => {
  const allClear: AutoQueueCapacity = {
    ok: true,
    rows: [
      { id: 'queue-depth', label: 'Queue depth', description: '', current: 1, limit: 2, met: true },
      { id: 'review-wip', label: 'Review WIP', description: '', current: 0, limit: 3, met: true },
      { id: 'epic-in-flight', label: 'Epic in flight', description: '', current: 0, limit: 1, met: true },
      { id: 'worker-healthy', label: 'Worker healthy', description: '', current: 0, limit: 1, met: true },
    ],
  };

  it('returns null when every board-wide limb has headroom and the Epic is not in flight', () => {
    expect(capacityWaitFor(allClear, {}, 5)).toBeNull();
    expect(capacityWaitFor(allClear, { 5: 0 }, 5)).toBeNull();
  });

  it('names the first unmet board-wide limb, formatted with its count', () => {
    // `capacity` (module-scoped) has review-wip 3/3 unmet, queue-depth met.
    expect(capacityWaitFor(capacity, {}, null)).toBe('Review WIP 3 / 3');
  });

  it('omits the count for the composite worker-healthy limb', () => {
    const unhealthy: AutoQueueCapacity = {
      ok: false,
      rows: [
        { id: 'queue-depth', label: 'Queue depth', description: '', current: 1, limit: 2, met: true },
        { id: 'review-wip', label: 'Review WIP', description: '', current: 0, limit: 3, met: true },
        { id: 'epic-in-flight', label: 'Epic in flight', description: '', current: 0, limit: 1, met: true },
        { id: 'worker-healthy', label: 'Worker healthy', description: '', current: 1, limit: 1, met: false, reason: 'Dispatch is paused.' },
      ],
    };
    expect(capacityWaitFor(unhealthy, {}, 5)).toBe('Worker healthy');
  });

  it('judges epic-in-flight per card from epicInFlight, ignoring the board-wide row', () => {
    expect(capacityWaitFor(allClear, { 5: 1 }, 5)).toBe('Epic in flight 1 / 1');
    // A different Epic at capacity does not hold this card back.
    expect(capacityWaitFor(allClear, { 9: 1 }, 5)).toBeNull();
  });
});

describe('buildChecklistView — Epic', () => {
  const members: AgentTicket[] = [
    { id: 1, displayId: 'PD-1', title: 'One' } as AgentTicket,
    { id: 2, displayId: 'PD-2', title: 'Two' } as AgentTicket,
  ];
  const epicEligibility: AutoQueueEpicEligibility = {
    criteria: [crit('epic-refined', true), crit('epic-active', false, { reason: 'Not active.' })],
    members: [
      { ticketId: 1, verdict: 'eligible' },
      { ticketId: 2, verdict: 'not-eligible' },
    ],
  };

  it('renders the Epic verdict, roll-up and member rows with links', () => {
    const v = buildChecklistView({
      isEpic: true,
      assignee: 'robot',
      mode: 'on',
      epicEligibility,
      capacity,
      members,
      ticketHref: (id) => `/devops/tickets/PD-${id}`,
    });
    expect(v.isEpic).toBe(true);
    expect(v.verdictLine).toBe('Not eligible — 1 unmet');
    expect(v.rollup).toBe('1 of 2 members eligible');
    expect(v.showCapacity).toBe(true);
    expect(v.members).toHaveLength(2);
    expect(v.members![0]).toMatchObject({ mark: '✓', verdictShort: 'eligible', href: '/devops/tickets/PD-1' });
    expect(v.members![1]).toMatchObject({ mark: '✗', verdictShort: 'not eligible', title: 'Two' });
  });

  it('all Epic criteria met → members-auto-queue verdict and eligible tone', () => {
    const v = buildChecklistView({
      isEpic: true,
      assignee: 'robot',
      mode: 'on',
      epicEligibility: { criteria: [crit('epic-refined', true), crit('epic-active', true)], members: [] },
      capacity,
      members: [],
      ticketHref: () => null,
    });
    expect(v.verdictLine).toBe('Members auto-queue as they become eligible');
    expect(v.verdictTone).toBe('eligible');
    expect(v.rollup).toBe('0 of 0 members eligible');
  });

  it('falls back to #id when a member ticket is not in the list', () => {
    const v = buildChecklistView({
      isEpic: true,
      assignee: 'robot',
      mode: 'on',
      epicEligibility: { criteria: [], members: [{ ticketId: 99, verdict: 'terminal' }] },
      capacity,
      members: [],
      ticketHref: () => null,
    });
    expect(v.members![0]).toMatchObject({ mark: '–', title: '#99', verdictShort: 'done' });
  });
});
