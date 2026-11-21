import { describe, it, expect } from 'vitest';
import { createRunOwnership } from './ownership';

describe('RunOwnership (PD-784/D-104)', () => {
  it('owns a run only between begin and end', () => {
    const o = createRunOwnership(100);
    const abort = new AbortController();
    expect(o.owns(7)).toBe(false);
    o.begin({ runId: 7, ticketId: 1, branch: 'robot/1', abort }, 200);
    expect(o.owns(7)).toBe(true);
    expect(o.get(7)?.ticketId).toBe(1);
    o.end(7);
    expect(o.owns(7)).toBe(false);
    expect(o.get(7)).toBeUndefined();
  });

  it('tracks last progress, defaulting to the start time', () => {
    const o = createRunOwnership(100);
    o.begin({ runId: 7, ticketId: 1, branch: 'robot/1', abort: new AbortController() }, 200);
    expect(o.lastProgressAt(7)).toBe(200);
    o.progress(7, 350);
    expect(o.lastProgressAt(7)).toBe(350);
  });

  it('lists in-flight runs for a graceful stop to abort', () => {
    const o = createRunOwnership(100);
    o.begin({ runId: 1, ticketId: 10, branch: 'robot/10', abort: new AbortController() }, 200);
    o.begin({ runId: 2, ticketId: 11, branch: 'robot/11', abort: new AbortController() }, 200);
    expect(o.inFlight().map((r) => r.runId).sort()).toEqual([1, 2]);
    o.end(1);
    expect(o.inFlight().map((r) => r.runId)).toEqual([2]);
  });

  it('exposes the process start time and is a harmless no-op on unknown ids', () => {
    const o = createRunOwnership(12345);
    expect(o.processStartedAt).toBe(12345);
    expect(() => o.progress(999, 1)).not.toThrow();
    expect(() => o.attachWorktree(999, { dir: '/x', branch: 'b' })).not.toThrow();
    expect(() => o.end(999)).not.toThrow();
    expect(o.lastProgressAt(999)).toBeUndefined();
  });
});
