import { describe, expect, it } from 'vitest';
import type { TinnitusEntry } from '@dashboard/shared';
import { RejectedError, UnreachableError } from './api';
import { flushPending, loadPending, newClientId, QUEUE_KEY, savePending, type PendingEntry } from './queue';

const pending = (clientId: string): PendingEntry => ({ clientId, recordedAt: 1, intensity: 3, tags: [] });
const saved = (p: PendingEntry): TinnitusEntry => ({
  id: 1,
  clientId: p.clientId,
  recordedAt: p.recordedAt,
  intensity: p.intensity,
  tags: [],
  notes: null,
  createdAt: 1,
  updatedAt: 1,
});

function memoryKV(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('flushPending', () => {
  it('sends everything when the server is up', async () => {
    const r = await flushPending([pending('a'), pending('b')], async (p) => saved(p));
    expect(r.sent.map((e) => e.clientId)).toEqual(['a', 'b']);
    expect(r.remaining).toEqual([]);
  });

  it('stops at the first unreachable failure and keeps it plus the rest, in order', async () => {
    const calls: string[] = [];
    const r = await flushPending([pending('a'), pending('b'), pending('c')], async (p) => {
      calls.push(p.clientId);
      if (p.clientId === 'b') throw new UnreachableError('down');
      return saved(p);
    });
    expect(calls).toEqual(['a', 'b']);
    expect(r.remaining.map((p) => p.clientId)).toEqual(['b', 'c']);
  });

  it('drops a rejected entry instead of letting it block the queue forever', async () => {
    const r = await flushPending([pending('bad'), pending('ok')], async (p) => {
      if (p.clientId === 'bad') throw new RejectedError('intensity must be…');
      return saved(p);
    });
    expect(r.rejected.map((x) => x.entry.clientId)).toEqual(['bad']);
    expect(r.sent.map((e) => e.clientId)).toEqual(['ok']);
    expect(r.remaining).toEqual([]);
  });

  it('keeps an entry on an unexpected error rather than lose it', async () => {
    const r = await flushPending([pending('a')], async () => {
      throw new Error('boom');
    });
    expect(r.remaining.map((p) => p.clientId)).toEqual(['a']);
  });
});

describe('storage', () => {
  it('round-trips, and treats junk or missing storage as an empty queue', () => {
    const kv = memoryKV();
    savePending([pending('a')], kv);
    expect(loadPending(kv)).toEqual([pending('a')]);
    expect(loadPending(memoryKV({ [QUEUE_KEY]: '{not json' }))).toEqual([]);
    expect(loadPending(memoryKV({ [QUEUE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadPending(null)).toEqual([]);
  });
});

describe('newClientId', () => {
  it('is unique across rapid calls', () => {
    expect(new Set(Array.from({ length: 500 }, newClientId)).size).toBe(500);
  });
});
