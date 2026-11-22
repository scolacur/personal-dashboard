import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  BREAKER_KEY,
  breakerFailures,
  recordDeterministicFailure,
  resetBreaker,
  breakerPauseReason,
  breakerNotificationBody,
  type BreakerFailure,
} from './breaker';

/** The breaker's state lives in the worker-owned robot_state k/v table — mirror its create. */
function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  return d;
}

const F = (ticketId: number, signature = `sig-${ticketId}`, title = `T${ticketId}`): BreakerFailure => ({
  ticketId,
  title,
  signature,
});

describe('breaker (t974, D-107)', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });

  it('starts empty and reads [] with no row', () => {
    expect(breakerFailures(d)).toEqual([]);
  });

  it('records distinct tickets, growing the streak', () => {
    expect(recordDeterministicFailure(d, F(1), 1000)).toHaveLength(1);
    expect(recordDeterministicFailure(d, F(2), 1001)).toHaveLength(2);
    const streak = recordDeterministicFailure(d, F(3), 1002);
    expect(streak.map((f) => f.ticketId)).toEqual([1, 2, 3]);
    // Persisted — a fresh read sees the same list.
    expect(breakerFailures(d).map((f) => f.ticketId)).toEqual([1, 2, 3]);
  });

  it('dedupes by ticketId: one flapping ticket does not grow the count', () => {
    recordDeterministicFailure(d, F(1, 'first'), 1000);
    recordDeterministicFailure(d, F(2), 1001);
    // Ticket 1 fails again with a new signature — count stays 2, and its signature refreshes.
    const streak = recordDeterministicFailure(d, F(1, 'second'), 1002);
    expect(streak).toHaveLength(2);
    expect(streak.map((f) => f.ticketId)).toEqual([2, 1]); // moved to the end
    expect(streak.find((f) => f.ticketId === 1)?.signature).toBe('second');
  });

  it('resetBreaker clears the streak', () => {
    recordDeterministicFailure(d, F(1), 1000);
    recordDeterministicFailure(d, F(2), 1001);
    resetBreaker(d, 1002);
    expect(breakerFailures(d)).toEqual([]);
  });

  it('reads [] from a corrupt row rather than wedging into a false trip', () => {
    d.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(BREAKER_KEY, '{oops', 1000);
    expect(breakerFailures(d)).toEqual([]);
  });

  it('the pause reason carries the circuit-breaker token and the ticket ids', () => {
    const reason = breakerPauseReason([F(1), F(2), F(3)]);
    expect(reason).toMatch(/circuit-breaker/);
    expect(reason).toContain('t1, t2, t3');
    expect(reason).toContain('3 consecutive');
  });

  it('the notification body names each ticket and its fault signature', () => {
    const body = breakerNotificationBody([F(7, 'path guard', 'Build the thing'), F(9, 'eacces', 'Other thing')]);
    expect(body).toContain('Build the thing (t7): path guard');
    expect(body).toContain('Other thing (t9): eacces');
    expect(body).toMatch(/resume dispatch/i);
  });
});
