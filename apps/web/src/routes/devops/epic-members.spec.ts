import { describe, it, expect } from 'vitest';
import type { AgentTicket, TicketAssignee, TicketStatus } from '@dashboard/shared';
import {
  MEMBER_ASSIGNEES,
  MEMBER_LANE_CHOICES,
  assigneeGlyph,
  canEditMember,
  canSetMemberLane,
  memberAssigneeHint,
  dispatchPositions,
  memberLockReason,
  membersReorderable,
  reorderedMembers,
  refinementBadge,
  planStaleInvalidation,
  stalePauseNotice,
} from './epic-members';

function member(over: Partial<AgentTicket> & { id: number }): AgentTicket {
  return {
    displayId: `PD-${over.id}`,
    title: `t${over.id}`,
    body: null,
    status: 'backlog' as TicketStatus,
    priority: null,
    assignee: null as TicketAssignee | null,
    sortOrder: over.id,
    isEpic: false,
    epicId: 1,
    agentState: null,
    ...over,
  } as AgentTicket;
}

describe('MEMBER_LANE_CHOICES', () => {
  // D-083: terminal is final. A dropdown that can complete a ticket in one click is the
  // easy slip that decision exists to prevent, and the Reopen that undoes it lives elsewhere.
  it('offers no terminal lane', () => {
    expect(MEMBER_LANE_CHOICES).toEqual(['backlog', 'queue']);
    expect(MEMBER_LANE_CHOICES).not.toContain('completed');
    expect(MEMBER_LANE_CHOICES).not.toContain('closed');
  });
});

describe('canSetMemberLane / memberLockReason', () => {
  it('lets an ordinary active member move', () => {
    const m = member({ id: 2, status: 'backlog' });
    expect(canSetMemberLane(m)).toBe(true);
    expect(memberLockReason(m)).toBeNull();
  });

  it('freezes a terminal member and says why', () => {
    for (const status of ['completed', 'closed'] as const) {
      const m = member({ id: 3, status });
      expect(canSetMemberLane(m)).toBe(false);
      expect(memberLockReason(m)).toMatch(/read-only|reopen/i);
    }
  });
});

describe('assignee on a member row (PD-532)', () => {
  it('offers unassigned as a real choice, first', () => {
    expect(MEMBER_ASSIGNEES).toEqual([null, 'steve', 'robot']);
  });

  // The whole point is that the member list and the board are scannable the same way, so the
  // glyphs must match TicketCard's exactly.
  it('uses the board’s glyphs, and a visible mark for unassigned', () => {
    expect(assigneeGlyph('steve')).toBe('S');
    expect(assigneeGlyph('robot')).toBe('🤖');
    expect(assigneeGlyph(null)).toBe('—');
    expect(assigneeGlyph(null)).not.toBe('');
  });

  // Assignee is the field that decides dispatch (`robotQueueCandidates` requires assignee=robot),
  // so the hint has to distinguish queued-and-armed from queued-but-never-going-to-run.
  it('says whether the member is actually a dispatch candidate', () => {
    const armed = member({ id: 1, status: 'queue', assignee: 'robot' });
    expect(memberAssigneeHint(armed)).toMatch(/candidate/i);

    const notQueued = member({ id: 2, status: 'backlog', assignee: 'robot' });
    expect(memberAssigneeHint(notQueued)).toMatch(/not queued/i);

    const personal = member({ id: 3, status: 'queue', assignee: 'steve' });
    expect(memberAssigneeHint(personal)).toMatch(/never dispatched/i);

    const nobody = member({ id: 4, status: 'queue', assignee: null });
    expect(memberAssigneeHint(nobody)).toMatch(/never dispatched/i);
  });

  // One predicate behind both controls, so a frozen row can never end up half-editable.
  it('gates assignee and lane on the same rule', () => {
    const live = member({ id: 5, status: 'backlog' });
    expect(canEditMember(live)).toBe(canSetMemberLane(live));

    const done = member({ id: 6, status: 'completed' });
    expect(canEditMember(done)).toBe(false);
    expect(canSetMemberLane(done)).toBe(false);
  });
});

describe('membersReorderable', () => {
  // A drag handle on a one-row list invites a gesture that cannot do anything.
  it('needs at least two members', () => {
    expect(membersReorderable([])).toBe(false);
    expect(membersReorderable([member({ id: 1 })])).toBe(false);
    expect(membersReorderable([member({ id: 1 }), member({ id: 2 })])).toBe(true);
  });
});

describe('reorderedMembers', () => {
  const list = [member({ id: 1 }), member({ id: 2 }), member({ id: 3 })];
  const ids = (ms: AgentTicket[]) => ms.map((m) => m.id);

  it('moves a row in front of the target', () => {
    expect(ids(reorderedMembers(list, 3, 1))).toEqual([3, 1, 2]);
    expect(ids(reorderedMembers(list, 1, 3))).toEqual([2, 1, 3]);
  });

  it('appends when there is no target', () => {
    expect(ids(reorderedMembers(list, 1, null))).toEqual([2, 3, 1]);
  });

  it('is a no-op when the row is dropped on itself', () => {
    expect(ids(reorderedMembers(list, 2, 2))).toEqual([1, 2, 3]);
  });

  it('never mutates the input, and ignores an unknown id', () => {
    const before = ids(list);
    expect(ids(reorderedMembers(list, 99, 1))).toEqual(before);
    expect(ids(list)).toEqual(before);
  });
});

describe('dispatchPositions', () => {
  // Only queue+robot members are ever candidates, so only they are numbered — numbering every row
  // would promise an order most of the list is not in.
  it('numbers only the members the Robot could actually pick up, in list order', () => {
    const list = [
      member({ id: 1, status: 'backlog', assignee: 'robot' }),
      member({ id: 2, status: 'queue', assignee: 'robot' }),
      member({ id: 3, status: 'queue', assignee: 'steve' }),
      member({ id: 4, status: 'queue', assignee: 'robot' }),
      member({ id: 5, status: 'completed', assignee: 'robot' }),
    ];
    const pos = dispatchPositions(list);
    expect(pos.get(2)).toBe(1);
    expect(pos.get(4)).toBe(2);
    expect(pos.has(1)).toBe(false);
    expect(pos.has(3)).toBe(false);
    expect(pos.has(5)).toBe(false);
  });

  it('renumbers from the list order, so a drag changes the positions', () => {
    const list = [
      member({ id: 1, status: 'queue', assignee: 'robot' }),
      member({ id: 2, status: 'queue', assignee: 'robot' }),
    ];
    expect(dispatchPositions(list).get(1)).toBe(1);
    expect(dispatchPositions(reorderedMembers(list, 2, 1)).get(2)).toBe(1);
  });
});

// ── PD-611: the stale Epic ───────────────────────────────────────────────────

describe('refinementBadge — the stale state', () => {
  it('marks a stale Epic as its own third state, not as refined or unrefined', () => {
    const badge = refinementBadge(member({ id: 9, isEpic: true, refined: false, refineStale: true }))!;
    expect(badge.text).toBe('⚠ Stale');
    expect(badge.cls).toContain('refine-stale');
    // The whole point of the third state (D-089 §2): it must not read as either neighbour.
    expect(badge.cls).not.toContain('refined-mark');
    expect(badge.cls).not.toContain('refine-start');
  });

  it('leaves a never-refined Epic exactly as it was — it gains no warning it was never eligible for', () => {
    const badge = refinementBadge(member({ id: 10, isEpic: true, refined: false, refineStale: false }))!;
    expect(badge.text).toBe('Not refined');
  });

  it('shows stale even while a Refine session is open on it', () => {
    // Precedence over `refineState`: opening a session does not un-stale the Epic, and the
    // staleness is the fact that gates re-queueing.
    const m = member({ id: 11, isEpic: true, refineStale: true, refineState: 'refining' });
    expect(refinementBadge(m)!.text).toBe('⚠ Stale');
  });

  it('still says nothing about a terminal member', () => {
    expect(refinementBadge(member({ id: 12, status: 'completed', refineStale: true }))).toBeNull();
  });
});

describe('planStaleInvalidation', () => {
  const epic = { isEpic: true, refined: true } as AgentTicket;

  it('is null for an Epic that was never refined — nothing to invalidate', () => {
    expect(planStaleInvalidation({ isEpic: true, refined: false } as AgentTicket, [])).toBeNull();
  });

  it('is null for a Ticket — `refined` has no membership half on one', () => {
    expect(planStaleInvalidation({ isEpic: false, refined: true } as AgentTicket, [])).toBeNull();
  });

  it('tells rather than asks when the Epic sits in Backlog', () => {
    const plan = planStaleInvalidation(epic, [member({ id: 2, status: 'backlog' })])!;
    expect(plan.needsConfirm).toBe(false);
    expect(plan.unarmed).toHaveLength(0);
  });

  it('asks when members would visibly leave the Queue', () => {
    const plan = planStaleInvalidation(epic, [
      member({ id: 2, status: 'queue', agentState: 'queued' }),
      member({ id: 3, status: 'queue', agentState: null }),
      member({ id: 4, status: 'backlog' }),
    ])!;
    expect(plan.needsConfirm).toBe(true);
    expect(plan.unarmed.map((m) => m.id)).toEqual([2, 3]);
  });

  it('does NOT ask when the only queued member is mid-run', () => {
    // D-046 leaves it running, so nothing moves — a modal here would offer a choice between two
    // identical outcomes.
    const plan = planStaleInvalidation(epic, [member({ id: 2, status: 'queue', agentState: 'working' })])!;
    expect(plan.needsConfirm).toBe(false);
    expect(plan.inFlight.map((m) => m.id)).toEqual([2]);
    expect(plan.unarmed).toHaveLength(0);
  });

  it('separates in-flight from un-armed so the modal can name both', () => {
    const plan = planStaleInvalidation(epic, [
      member({ id: 2, status: 'queue', agentState: 'in-review' }),
      member({ id: 3, status: 'queue', agentState: 'queued' }),
    ])!;
    expect(plan.inFlight.map((m) => m.id)).toEqual([2]);
    expect(plan.unarmed.map((m) => m.id)).toEqual([3]);
  });

  it('ignores terminal members — the Epic making progress is not the Epic changing', () => {
    const plan = planStaleInvalidation(epic, [
      member({ id: 2, status: 'completed' }),
      member({ id: 3, status: 'closed' }),
    ])!;
    expect(plan.needsConfirm).toBe(false);
  });
});

describe('stalePauseNotice', () => {
  const stale = (over: Partial<AgentTicket> = {}) =>
    ({ isEpic: true, refineStale: true, status: 'queue', ...over }) as AgentTicket;

  it('explains a paused Epic whose members are sitting in Backlog', () => {
    const notice = stalePauseNotice(stale(), [
      member({ id: 2, status: 'backlog' }),
      member({ id: 3, status: 'backlog' }),
      member({ id: 4, status: 'queue', agentState: 'working' }),
    ])!;
    expect(notice.unarmed).toBe(2);
    expect(notice.inFlight).toBe(1);
  });

  it('says nothing when the Epic is stale but in Backlog — nothing moved', () => {
    expect(stalePauseNotice(stale({ status: 'backlog' }), [member({ id: 2, status: 'backlog' })])).toBeNull();
  });

  it('says nothing when the Epic is not stale', () => {
    expect(stalePauseNotice(stale({ refineStale: false }), [member({ id: 2, status: 'backlog' })])).toBeNull();
  });

  it('says nothing when every member is still armed', () => {
    expect(stalePauseNotice(stale(), [member({ id: 2, status: 'queue', agentState: 'queued' })])).toBeNull();
  });

  it('ignores terminal members when counting what is waiting', () => {
    expect(stalePauseNotice(stale(), [member({ id: 2, status: 'completed' })])).toBeNull();
  });
});
