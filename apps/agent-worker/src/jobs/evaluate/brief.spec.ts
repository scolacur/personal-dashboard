import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { pendingEvaluatorBrief } from './brief';

describe('pendingEvaluatorBrief when the Evaluator was never started', () => {
  it('returns null instead of throwing, because it is read on the DISPATCH path', () => {
    // `evaluator_runs` is created by startEvaluatorJob. A deployment that never starts the
    // Evaluator — or a boot ordering where the Robot ticks first — must still dispatch. Throwing
    // here would take down the Robot loop over an optional reviewer. This crashed 28 robot specs
    // before the guard existed.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);');
    expect(() => pendingEvaluatorBrief(db, 1)).not.toThrow();
    expect(pendingEvaluatorBrief(db, 1)).toBeNull();
  });
});
