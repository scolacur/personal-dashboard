import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  BREAKER_REASON_PREFIX,
  breakerFailures,
  breakerPauseReason,
  breakerTripped,
  recordBreakerFailure,
  resetBreaker,
  type BreakerFailure,
} from './breaker';
import { ensureRobotStateTable, resumeDispatch, pauseDispatch, isDispatchPaused } from './state';

const f = (ticketId: number, signature = 'sig', displayId: string | null = null): BreakerFailure => ({
  ticketId,
  displayId,
  signature,
});

describe('circuit breaker state', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureRobotStateTable(db);
  });

  it('defaults to an empty list', () => {
    expect(breakerFailures(db)).toEqual([]);
  });

  it('records distinct deterministic failures in order', () => {
    recordBreakerFailure(db, f(1, 'a'), 1000);
    const list = recordBreakerFailure(db, f(2, 'b'), 2000);
    expect(list.map((x) => x.ticketId)).toEqual([1, 2]);
    expect(breakerFailures(db)).toHaveLength(2);
  });

  it('dedupes by ticket id — a re-queued ticket failing again does not double-count', () => {
    recordBreakerFailure(db, f(1, 'a'), 1000);
    const list = recordBreakerFailure(db, f(1, 'a-again'), 2000);
    expect(list).toHaveLength(1);
    expect(list[0].signature).toBe('a'); // keeps the first-seen signature
  });

  it('resets to empty', () => {
    recordBreakerFailure(db, f(1), 1000);
    recordBreakerFailure(db, f(2), 1000);
    resetBreaker(db, 1500);
    expect(breakerFailures(db)).toEqual([]);
  });

  it('trips at the threshold on DISTINCT tickets, not before', () => {
    expect(breakerTripped([f(1), f(2)], 3)).toBe(false);
    expect(breakerTripped([f(1), f(2), f(3)], 3)).toBe(true);
  });

  it('a threshold of 0 disables the breaker', () => {
    expect(breakerTripped([f(1), f(2), f(3), f(4)], 0)).toBe(false);
  });

  it('the pause reason is distinguishable and names the failing tickets + signatures', () => {
    const reason = breakerPauseReason([f(1, 'npm ci failed', 'PD-1'), f(2, 'tsc error')]);
    expect(reason.startsWith(BREAKER_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('PD-1 (npm ci failed)');
    expect(reason).toContain('#2 (tsc error)'); // no display id ⇒ falls back to #id
  });

  it('a human resume clears the count (resumeDispatch resets the breaker)', () => {
    pauseDispatch(db, 'circuit-breaker: …', 1000);
    recordBreakerFailure(db, f(1), 1000);
    recordBreakerFailure(db, f(2), 1000);
    resumeDispatch(db, 2000);
    expect(isDispatchPaused(db)).toBe(false);
    expect(breakerFailures(db)).toEqual([]);
  });

  it('tolerates a corrupt row rather than wedging a dispatch cycle', () => {
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run('circuit_breaker', 'not json', 1000);
    expect(breakerFailures(db)).toEqual([]);
  });
});
