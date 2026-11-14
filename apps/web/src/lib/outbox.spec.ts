import { describe, expect, it } from 'vitest';
import { createOutbox, flushQueue, loadQueue, saveQueue, type OutboxStorage } from './outbox';

// A stand-in payload — the outbox is generic, so these tests use a trivial shape.
interface Payload {
  id: string;
}
const p = (id: string): Payload => ({ id });

class Refused extends Error {}
const isRejected = (e: unknown) => e instanceof Refused;

function memoryKV(initial: Record<string, string> = {}): OutboxStorage {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const KEY = 'test:pending';

describe('flushQueue', () => {
  it('sends everything when the server is up', async () => {
    const r = await flushQueue([p('a'), p('b')], async (e) => ({ ...e, id: e.id }), isRejected);
    expect(r.sent.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.remaining).toEqual([]);
  });

  it('stops at the first unreachable failure and keeps it plus the rest, in order', async () => {
    const calls: string[] = [];
    const r = await flushQueue(
      [p('a'), p('b'), p('c')],
      async (e) => {
        calls.push(e.id);
        if (e.id === 'b') throw new Error('down');
        return e;
      },
      isRejected,
    );
    expect(calls).toEqual(['a', 'b']);
    expect(r.remaining.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('drops a rejected entry instead of letting it block the queue forever', async () => {
    const r = await flushQueue(
      [p('bad'), p('ok')],
      async (e) => {
        if (e.id === 'bad') throw new Refused('nope');
        return e;
      },
      isRejected,
    );
    expect(r.rejected.map((x) => x.entry.id)).toEqual(['bad']);
    expect(r.rejected[0].message).toBe('nope');
    expect(r.sent.map((e) => e.id)).toEqual(['ok']);
    expect(r.remaining).toEqual([]);
  });

  it('keeps an entry on an unexpected (non-rejected) error rather than lose it', async () => {
    const r = await flushQueue(
      [p('a')],
      async () => {
        throw new Error('boom');
      },
      isRejected,
    );
    expect(r.remaining.map((e) => e.id)).toEqual(['a']);
  });
});

describe('storage', () => {
  it('round-trips, and treats junk or missing storage as an empty queue', () => {
    const kv = memoryKV();
    saveQueue(KEY, [p('a')], kv);
    expect(loadQueue<Payload>(KEY, kv)).toEqual([p('a')]);
    expect(loadQueue(KEY, memoryKV({ [KEY]: '{not json' }))).toEqual([]);
    expect(loadQueue(KEY, memoryKV({ [KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadQueue(KEY, null)).toEqual([]);
  });

  it('a write under one key does not disturb another key already pending (shared storage, per-widget keys)', () => {
    const kv = memoryKV({ 'other:pending': JSON.stringify([p('keep')]) });
    saveQueue(KEY, [p('a')], kv);
    expect(loadQueue<Payload>('other:pending', kv)).toEqual([p('keep')]);
  });
});

describe('createOutbox', () => {
  it('loads a pre-seeded queue on start (entries pending before the code changed are not lost)', () => {
    const kv = memoryKV({ [KEY]: JSON.stringify([p('old')]) });
    const seen: Payload[][] = [];
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send: async (e) => e,
      isRejected,
      kv,
      onChange: (list) => seen.push(list),
    });
    outbox.start();
    expect(outbox.pending().map((e) => e.id)).toEqual(['old']);
    expect(seen.at(-1)?.map((e) => e.id)).toEqual(['old']);
  });

  it('add persists, flushes, reports sent, and clears the queue when the server is up', async () => {
    const kv = memoryKV();
    const sent: Payload[] = [];
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send: async (e) => e,
      isRejected,
      kv,
      onSent: (s) => sent.push(...s),
    });
    outbox.add(p('a'));
    // add kicks a flush; let the microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((e) => e.id)).toEqual(['a']);
    expect(outbox.pending()).toEqual([]);
    expect(loadQueue<Payload>(KEY, kv)).toEqual([]);
  });

  it('keeps an unreachable entry queued and persisted, and reports a rejection', async () => {
    // Seed both entries up front (via start) so the flushes below are deterministic rather than
    // racing the auto-flush that `add` kicks.
    const kv = memoryKV({ [KEY]: JSON.stringify([p('bad'), p('a')]) });
    const rejected: string[] = [];
    let reachable = false;
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send: async (e) => {
        if (e.id === 'bad') throw new Refused('refused');
        if (!reachable) throw new Error('offline');
        return e;
      },
      isRejected,
      kv,
      onRejected: (e) => rejected.push(e.id),
    });

    outbox.start();
    await outbox.flush();
    expect(rejected).toEqual(['bad']);
    // 'a' stays queued while offline, and is persisted so a reload keeps it.
    expect(outbox.pending().map((e) => e.id)).toEqual(['a']);
    expect(loadQueue<Payload>(KEY, kv).map((e) => e.id)).toEqual(['a']);

    reachable = true;
    await outbox.flush();
    expect(outbox.pending()).toEqual([]);
    expect(loadQueue<Payload>(KEY, kv)).toEqual([]);
  });

  it('is re-entrant-safe: a second flush while one is in flight is a no-op', async () => {
    const kv = memoryKV();
    let inFlight = 0;
    let maxConcurrent = 0;
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send: async (e) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await Promise.resolve();
        inFlight--;
        return e;
      },
      isRejected,
      kv,
    });
    outbox.add(p('a'));
    await Promise.all([outbox.flush(), outbox.flush()]);
    expect(maxConcurrent).toBe(1);
  });
});
