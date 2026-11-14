import { describe, expect, it } from 'vitest';
import { newClientId } from './queue';

// The outbox mechanics (flush loop, storage) moved to `$lib/outbox` and are covered by
// `src/lib/outbox.spec.ts` (PD-736). What stays here is Tinnitus's own payload helper.

describe('newClientId', () => {
  it('is unique across rapid calls', () => {
    expect(new Set(Array.from({ length: 500 }, newClientId)).size).toBe(500);
  });
});
