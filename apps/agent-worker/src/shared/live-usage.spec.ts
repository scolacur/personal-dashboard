import { describe, it, expect } from 'vitest';
import { createLiveUsageCounter, safeProgress } from './live-usage';

const a = (id: string | undefined, usage?: object, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { ...(id ? { id } : {}), ...(usage ? { usage } : {}) },
});

describe('createLiveUsageCounter', () => {
  it('advances once per distinct top-level turn and sums that turn’s usage once', () => {
    const count = createLiveUsageCounter();
    const u1 = { input_tokens: 1000, output_tokens: 200 };
    expect(count(a('m1', u1))).toEqual({ turns: 1, tokens: 1200 });
    expect(count(a('m1', u1))).toBeNull(); // second content block of the same turn
    expect(count({ type: 'user' })).toBeNull();
    expect(count(a('sub', u1, 'toolu_1'))).toBeNull(); // sub-agent turn
    expect(count(a('m2', { input_tokens: 300, output_tokens: 50 }))).toEqual({ turns: 2, tokens: 1550 });
  });

  it('reports tokens as unknown, not 0, until some message carries usage', () => {
    const count = createLiveUsageCounter();
    expect(count(a('m1'))).toEqual({ turns: 1, tokens: undefined });
    expect(count(a('m2', { input_tokens: 5 }))).toEqual({ turns: 2, tokens: 5 });
  });

  it('counts an id-less message as its own turn rather than dropping it', () => {
    const count = createLiveUsageCounter();
    expect(count(a(undefined))?.turns).toBe(1);
    expect(count(a(undefined))?.turns).toBe(2);
  });
});

describe('safeProgress', () => {
  it('reports, and swallows a reporting failure into onError', () => {
    const seen: unknown[] = [];
    safeProgress((t, k) => seen.push([t, k]), { turns: 1, tokens: 9 }, () => {});
    expect(seen).toEqual([[1, 9]]);

    const errors: unknown[] = [];
    safeProgress(() => { throw new Error('db locked'); }, { turns: 2, tokens: 9 }, (e) => errors.push(e));
    expect(errors).toHaveLength(1);
  });

  it('does nothing with no callback or no new turn', () => {
    expect(() => safeProgress(undefined, { turns: 1, tokens: 1 }, () => {})).not.toThrow();
    let called = false;
    safeProgress(() => (called = true), null, () => {});
    expect(called).toBe(false);
  });
});
