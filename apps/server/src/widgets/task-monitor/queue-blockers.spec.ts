import { describe, it, expect } from 'vitest';
import { queueBlockers, queueEntryRefusals, type QueueCriterionId } from '@dashboard/shared';

// D-091 (PD-632). `queueBlockers` lives in packages/shared; it is tested here, beside
// `is-ready.spec.ts`, because packages/shared has no test runner of its own.

const ticket = { id: 1, refined: true, ready: true, readyBypassed: false };
const epic = { id: 10, refined: true, refineStale: false };
const member = (id: number, refined: boolean, status: 'backlog' | 'queue' | 'completed' | 'closed' = 'backlog') => ({
  id,
  refined,
  status,
});

function byId(input: Parameters<typeof queueBlockers>[0]) {
  return Object.fromEntries(queueBlockers(input).map((c) => [c.id, c])) as Record<
    QueueCriterionId,
    ReturnType<typeof queueBlockers>[number]
  >;
}

const allClear = { ticket, epic, members: [member(1, true), member(2, true)], openBlockerIds: [] };

describe('queueBlockers (D-091)', () => {
  it('returns every criterion, in display order, all met for a refined ticket under a refined Epic', () => {
    const c = queueBlockers(allClear);
    expect(c.map((x) => x.id)).toEqual(['refined', 'epic-refined', 'epic-not-stale', 'members-refined', 'ready', 'unblocked']);
    expect(c.every((x) => x.met)).toBe(true);
    expect(queueEntryRefusals(c)).toEqual([]);
  });

  it('refined — the ticket’s own flag, hard', () => {
    const c = byId({ ...allClear, ticket: { ...ticket, refined: false } });
    expect(c.refined).toMatchObject({ met: false, bypassable: false, refusesEntry: true, remedy: { kind: 'mark-refined', ticketId: 1 } });
  });

  it('epic-refined — its Epic’s flag, hard', () => {
    const c = byId({ ...allClear, epic: { ...epic, refined: false } });
    expect(c['epic-refined']).toMatchObject({ met: false, refusesEntry: true, remedy: { kind: 'mark-refined', ticketId: 10 } });
  });

  it('epic-not-stale — a stale Epic (D-089) refuses, with re-refine as the remedy', () => {
    const c = byId({ ...allClear, epic: { ...epic, refineStale: true } });
    expect(c['epic-not-stale']).toMatchObject({ met: false, refusesEntry: true, remedy: { kind: 'refine-epic', ticketId: 10 } });
  });

  it('members-refined — derived from the members, and counts the unrefined ones', () => {
    const c = byId({ ...allClear, members: [member(1, true), member(2, false), member(3, false, 'queue')] });
    expect(c['members-refined']).toMatchObject({ met: false, refusesEntry: true, remedy: { kind: 'open-epic', ticketId: 10 } });
    expect(c['members-refined'].label).toMatch(/^2 open members/);
  });

  it('members-refined — terminal members are excluded', () => {
    const c = byId({ ...allClear, members: [member(1, true), member(2, false, 'completed'), member(3, false, 'closed')] });
    expect(c['members-refined'].met).toBe(true);
  });

  it('members-refined — the ticket being queued is judged by `refined`, not counted again', () => {
    const c = byId({ ...allClear, ticket: { ...ticket, refined: false }, members: [member(1, false), member(2, true)] });
    expect(c['members-refined'].met).toBe(true);
    expect(queueEntryRefusals(Object.values(c)).map((x) => x.id)).toEqual(['refined']);
  });

  it('no Epic — every Epic criterion is met; only the ticket’s own refinement counts', () => {
    const c = byId({ ticket: { ...ticket, refined: false }, epic: null, members: [], openBlockerIds: [] });
    expect(c['epic-refined'].met).toBe(true);
    expect(c['epic-not-stale'].met).toBe(true);
    expect(c['members-refined'].met).toBe(true);
    expect(c.refined.met).toBe(false);
  });

  it('ready — bypassable, and met by a bypass; never refuses entry', () => {
    const notReady = byId({ ...allClear, ticket: { ...ticket, ready: false } });
    expect(notReady.ready).toMatchObject({ met: false, bypassable: true, refusesEntry: false, remedy: { kind: 'edit-body' } });
    const bypassed = byId({ ...allClear, ticket: { ...ticket, ready: false, readyBypassed: true } });
    expect(bypassed.ready.met).toBe(true);
    expect(queueEntryRefusals(Object.values(notReady))).toEqual([]);
  });

  it('unblocked — reported, but enforced at dispatch, not entry (D-051 as amended by PD-408)', () => {
    const c = byId({ ...allClear, openBlockerIds: [7, 8] });
    expect(c.unblocked).toMatchObject({ met: false, bypassable: false, refusesEntry: false, remedy: { kind: 'resolve-blocker', ticketId: 7 } });
    expect(queueEntryRefusals(Object.values(c))).toEqual([]);
  });

  it('queueEntryRefusals returns every unmet entry-refusing criterion, in order', () => {
    const c = queueBlockers({
      ticket: { ...ticket, refined: false, ready: false },
      epic: { id: 10, refined: false, refineStale: true },
      members: [member(2, false)],
      openBlockerIds: [9],
    });
    expect(queueEntryRefusals(c).map((x) => x.id)).toEqual(['refined', 'epic-refined', 'epic-not-stale', 'members-refined']);
  });
});
