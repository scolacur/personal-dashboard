import { describe, it, expect } from 'vitest';
import type { QueueCriterion } from '@dashboard/shared';
import { predictQueueRefusals, refusalHint, refusalRows, type EpicLike, type MemberLike } from './refine-queue-gate';

const epic = (over: Partial<EpicLike> = {}): EpicLike => ({
  id: 530,
  displayId: 'PD-530',
  title: 'Pomodoro V2',
  refined: true,
  refineStale: false,
  ...over,
});
const member = (id: number, refined: boolean, over: Partial<MemberLike> = {}): MemberLike => ({
  id,
  displayId: `PD-${id}`,
  title: `Member ${id}`,
  refined,
  status: 'backlog',
  ...over,
});

describe('predictQueueRefusals (PD-760)', () => {
  it('foresees nothing without an Epic, or with a refined, current Epic whose members are refined', () => {
    expect(predictQueueRefusals(596, null, [])).toEqual([]);
    expect(predictQueueRefusals(596, epic(), [member(596, false), member(757, true)])).toEqual([]);
  });

  it('ignores the ticket itself, which approval refines', () => {
    expect(predictQueueRefusals(596, epic(), [member(596, false)])).toEqual([]);
  });

  it('foresees an unrefined Epic, a stale Epic, and unrefined members', () => {
    expect(predictQueueRefusals(596, epic({ refined: false }), []).map((c) => c.id)).toEqual(['epic-refined']);
    expect(predictQueueRefusals(596, epic({ refineStale: true }), []).map((c) => c.id)).toEqual(['epic-not-stale']);
    expect(predictQueueRefusals(596, epic(), [member(1, false)]).map((c) => c.id)).toEqual(['members-refined']);
    expect(predictQueueRefusals(596, epic(), [member(1, false, { status: 'completed' })])).toEqual([]);
  });
});

describe('refusalRows (PD-760)', () => {
  it('names the Epic and offers Mark refined for an unrefined Epic', () => {
    const e = epic({ refined: false });
    const rows = refusalRows(predictQueueRefusals(596, e, []), e);
    expect(rows).toEqual([
      {
        id: 'epic-refined',
        label: 'Epic PD-530 (Pomodoro V2) is not refined',
        action: { kind: 'mark-epic-refined', epicId: 530, text: 'Mark PD-530 refined' },
      },
    ]);
  });

  it('links the Epic for a stale one, and the first unrefined member for members-refined', () => {
    const stale = epic({ refineStale: true });
    expect(refusalRows(predictQueueRefusals(596, stale, []), stale)[0].action).toEqual({
      kind: 'link',
      href: '/devops/tickets/PD-530',
      text: 'Open PD-530',
    });
    const members = [member(596, false), member(12, false)];
    const rows = refusalRows(predictQueueRefusals(596, epic(), members), epic(), members, 596);
    expect(rows[0].label).toBe('1 open member of PD-530 (Pomodoro V2) is not refined');
    expect(rows[0].action).toEqual({ kind: 'link', href: '/devops/tickets/PD-12', text: 'Open PD-12' });
  });

  it("renders the server's criteria it cannot place with no action, and drops met or non-refusing ones", () => {
    const server: QueueCriterion[] = [
      { id: 'refined', label: 'This ticket is not refined', met: false, bypassable: false, refusesEntry: true, remedy: { kind: 'mark-refined' } },
      { id: 'ready', label: 'The body is missing a Ready section', met: false, bypassable: true, refusesEntry: false, remedy: { kind: 'edit-body' } },
      { id: 'epic-refined', label: 'Its Epic is refined', met: true, bypassable: false, refusesEntry: true, remedy: { kind: 'mark-refined' } },
    ];
    expect(refusalRows(server, null)).toEqual([{ id: 'refined', label: 'This ticket is not refined', action: null }]);
  });
});

describe('refusalHint (PD-760)', () => {
  it('says why in a few words, or nothing when nothing is foreseen', () => {
    expect(refusalHint([], epic())).toBeNull();
    const e = epic({ refined: false });
    expect(refusalHint(predictQueueRefusals(596, e, []), e)).toBe('Epic PD-530 not refined');
  });
});
