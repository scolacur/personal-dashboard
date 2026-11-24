import { describe, expect, it } from 'vitest';
import { newClientId } from './queue';

// The outbox mechanics are covered by `src/lib/outbox.spec.ts`; this is the Sleep Journal's payload helper.

describe('newClientId', () => {
  it('is unique across rapid calls', () => {
    expect(new Set(Array.from({ length: 500 }, newClientId)).size).toBe(500);
  });
});
