import { describe, expect, it } from 'vitest';
import { collapseByKey } from '../../../lib/outbox';
import {
  applyPendingCompletions,
  applyPendingMetrics,
  pendingKey,
  type PendingHabitWrite,
} from './queue';

const completion = (itemId: number, day: string, done: boolean): PendingHabitWrite => ({
  kind: 'completion',
  itemId,
  day,
  done,
});
const metric = (itemId: number, day: string, value: string | null): PendingHabitWrite => ({
  kind: 'metric',
  itemId,
  day,
  value,
});

describe('pendingKey', () => {
  it('keys on (item, day), so writes to the same cell collapse and writes to different cells do not', () => {
    expect(pendingKey(completion(1, '2026-11-16', true))).toBe('1:2026-11-16');
    // Same item, different day → different subjects.
    expect(pendingKey(completion(1, '2026-11-15', true))).not.toBe(pendingKey(completion(1, '2026-11-16', true)));
    // A metric and a completion for the same item+day share a key (an item is only ever one kind).
    expect(pendingKey(metric(1, '2026-11-16', '8:42'))).toBe(pendingKey(completion(1, '2026-11-16', true)));
  });
});

describe('collapse of habit writes (outbox collapseKey = pendingKey)', () => {
  it('collapses a flurry of toggles on one habit to its final state', () => {
    const r = collapseByKey(
      [completion(1, 'd', true), completion(1, 'd', false), completion(1, 'd', true)],
      pendingKey,
    );
    expect(r).toEqual([completion(1, 'd', true)]);
  });

  it('collapses repeated metric edits on one cell to the latest value, cleared included', () => {
    const r = collapseByKey([metric(5, 'd', '8:00'), metric(5, 'd', '8:42'), metric(5, 'd', null)], pendingKey);
    expect(r).toEqual([metric(5, 'd', null)]);
  });

  it('keeps writes to distinct (item, day) cells separate, in first-seen order', () => {
    const r = collapseByKey(
      [completion(1, 'd', true), completion(2, 'd', false), completion(1, 'd', false), metric(3, 'd', '2')],
      pendingKey,
    );
    expect(r).toEqual([completion(1, 'd', false), completion(2, 'd', false), metric(3, 'd', '2')]);
  });
});

describe('applyPendingCompletions', () => {
  it('folds an unsynced tick over the server state so it does not visually revert', () => {
    const done = applyPendingCompletions([2], [completion(1, 'today', true)], 'today');
    expect([...done].sort()).toEqual([1, 2]);
  });

  it('folds an unsynced untick, removing a server-done item', () => {
    const done = applyPendingCompletions([1, 2], [completion(1, 'today', false)], 'today');
    expect([...done]).toEqual([2]);
  });

  it('applies pending in order, so the last write for a cell wins', () => {
    const done = applyPendingCompletions(
      [],
      [completion(1, 'today', true), completion(1, 'today', false), completion(1, 'today', true)],
      'today',
    );
    expect([...done]).toEqual([1]);
  });

  it('ignores writes for other days and metric writes', () => {
    const done = applyPendingCompletions(
      [1],
      [completion(1, 'yesterday', false), completion(2, 'today', true), metric(1, 'today', '8:00')],
      'today',
    );
    expect([...done].sort()).toEqual([1, 2]);
  });
});

describe('applyPendingMetrics', () => {
  it('folds an unsynced metric value over the server value so it does not revert', () => {
    const values = applyPendingMetrics([[5, '0']], [metric(5, 'today', '2')], 'today');
    expect(values.get(5)).toBe('2');
  });

  it('a pending clear (null) overrides a server value, distinct from leaving it', () => {
    const values = applyPendingMetrics([[5, '2']], [metric(5, 'today', null)], 'today');
    expect(values.get(5)).toBeNull();
    expect(values.has(5)).toBe(true);
  });

  it('applies pending in order, last write wins, and ignores other days / completions', () => {
    const values = applyPendingMetrics(
      [[5, '1']],
      [
        metric(5, 'today', '2'),
        metric(5, 'today', '3'),
        metric(5, 'yesterday', '9'),
        completion(5, 'today', true),
      ],
      'today',
    );
    expect(values.get(5)).toBe('3');
  });
});
