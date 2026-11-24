import { describe, it, expect } from 'vitest';
import { workerVersionState } from '@dashboard/shared';

// PD-528. The bug this replaces: Site Status rendered the GROUNDING CHECKOUT's sha as if it were
// the worker's version. The checkout is re-pulled continuously, so a container running week-old
// code advertised a fresh-looking sha — and `EVALUATOR_ENABLED` would have been flipped on for an
// image that did not contain the Evaluator.
describe('workerVersionState', () => {
  it('is current only when the running build matches the checkout', () => {
    expect(workerVersionState({ buildSha: 'abc1234', checkoutSha: 'abc1234' })).toBe('current');
  });

  it('is stale when the worker runs older code than it grounds against', () => {
    // Exactly the 2026-08-13 state: container up 7 days, main far ahead.
    expect(workerVersionState({ buildSha: '41cdc4d', checkoutSha: '3a29bf8' })).toBe('stale');
  });

  it('is unknown — NOT current — on an image built before build-sha stamping', () => {
    // "We cannot tell" must never render as "you are up to date": that is the same false
    // reassurance the old behaviour gave, just from a different direction.
    expect(workerVersionState({ buildSha: null, checkoutSha: 'abc1234' })).toBe('unknown');
  });

  it('is current when main moved on without touching the worker build inputs (PD-816)', () => {
    // The worker image publishes only on worker-affecting merges, so a web-only merge leaves the
    // shas different with nothing to deploy.
    expect(workerVersionState({ buildSha: '41cdc4d', checkoutSha: '3a29bf8', buildCurrent: true })).toBe('current');
  });

  it('stays stale when a build input changed, or when the worker cannot tell (PD-816)', () => {
    expect(workerVersionState({ buildSha: '41cdc4d', checkoutSha: '3a29bf8', buildCurrent: false })).toBe('stale');
    expect(workerVersionState({ buildSha: '41cdc4d', checkoutSha: '3a29bf8', buildCurrent: null })).toBe('stale');
  });

  it('never lets buildCurrent override an unknown build sha', () => {
    expect(workerVersionState({ buildSha: null, checkoutSha: '3a29bf8', buildCurrent: true })).toBe('unknown');
  });

  it('is unknown when the checkout sha is unreadable, rather than guessing', () => {
    expect(workerVersionState({ buildSha: 'abc1234', checkoutSha: null })).toBe('unknown');
    expect(workerVersionState({ buildSha: null, checkoutSha: null })).toBe('unknown');
  });
});
