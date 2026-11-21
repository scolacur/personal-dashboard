import { describe, it, expect } from 'vitest';
import { createRunOwnership } from './ownership';
import { RobotShutdown, timeout } from './shutdown';

describe('RobotShutdown (PD-784/D-104)', () => {
  it('aborts every in-flight session on request and flips `requested`', () => {
    const o = createRunOwnership(100);
    const a = new AbortController();
    const b = new AbortController();
    o.begin({ runId: 1, ticketId: 10, branch: 'robot/10', abort: a }, 200);
    o.begin({ runId: 2, ticketId: 11, branch: 'robot/11', abort: b }, 200);
    const sd = new RobotShutdown(o);

    expect(sd.requested).toBe(false);
    sd.request();
    expect(sd.requested).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('is idempotent — a second request is a no-op', () => {
    const o = createRunOwnership(100);
    const sd = new RobotShutdown(o);
    sd.request();
    expect(() => sd.request()).not.toThrow();
    expect(sd.requested).toBe(true);
  });

  it('timeout resolves to its fallback', async () => {
    await expect(timeout(1, 'fell-back')).resolves.toBe('fell-back');
  });

  it('timeout loses a race against an already-resolved promise', async () => {
    const winner = await Promise.race([Promise.resolve('work'), timeout(50, 'fallback')]);
    expect(winner).toBe('work');
  });
});
