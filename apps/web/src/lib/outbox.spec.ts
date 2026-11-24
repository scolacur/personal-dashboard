import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseByKey, createOutbox, flushQueue, loadQueue, saveQueue, type OutboxStorage } from './outbox';

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

describe('collapseByKey', () => {
  interface SetState {
    subject: string;
    v: number;
  }
  const key = (e: SetState) => e.subject;

  it('keeps only the latest entry per key, in first-seen order', () => {
    const r = collapseByKey(
      [
        { subject: 'a', v: 1 },
        { subject: 'b', v: 1 },
        { subject: 'a', v: 2 },
        { subject: 'a', v: 3 },
      ],
      key,
    );
    expect(r).toEqual([
      { subject: 'a', v: 3 },
      { subject: 'b', v: 1 },
    ]);
  });

  it('leaves a queue with no duplicates untouched', () => {
    const list = [
      { subject: 'a', v: 1 },
      { subject: 'b', v: 2 },
    ];
    expect(collapseByKey(list, key)).toEqual(list);
  });
});

describe('createOutbox', () => {
  it('collapses per key while offline, so only the latest set-state for a subject is sent', async () => {
    const kv = memoryKV();
    const sent: string[] = [];
    let reachable = false;
    const outbox = createOutbox<{ subject: string; done: boolean }, void>({
      key: KEY,
      send: async (e) => {
        if (!reachable) throw new Error('offline');
        sent.push(`${e.subject}=${e.done}`);
      },
      isRejected,
      kv,
      collapseKey: (e) => e.subject,
    });
    // Tick then untick the same subject while offline (each add auto-flushes but fails to send).
    outbox.add({ subject: 'x', done: true });
    outbox.add({ subject: 'x', done: false });
    outbox.add({ subject: 'y', done: true });
    // Let the failed auto-flushes settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(outbox.pending()).toEqual([
      { subject: 'x', done: false },
      { subject: 'y', done: true },
    ]);
    // Only the collapsed final states remain, and only those are sent once reachable.
    reachable = true;
    await outbox.flush();
    expect(sent).toEqual(['x=false', 'y=true']);
    expect(outbox.pending()).toEqual([]);
  });

  it('collapses a pre-seeded queue on start', () => {
    const kv = memoryKV({
      [KEY]: JSON.stringify([
        { subject: 'x', done: true },
        { subject: 'x', done: false },
      ]),
    });
    const outbox = createOutbox<{ subject: string; done: boolean }, void>({
      key: KEY,
      send: async () => {},
      isRejected,
      kv,
      collapseKey: (e) => e.subject,
    });
    outbox.start();
    expect(outbox.pending()).toEqual([{ subject: 'x', done: false }]);
  });


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

describe('visible pending signal (PD-778)', () => {
  // The delay timer is guarded behind `typeof window`, like the retry triggers; the suite runs in
  // node, so stand in a window and drive time with fake timers.
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A send the test resolves or fails by hand, so "slow" and "fast" are under its control. */
  function controlledSend() {
    const calls: { resolve: () => void; reject: (e: unknown) => void }[] = [];
    const send = (e: Payload) =>
      new Promise<Payload>((resolve, reject) => calls.push({ resolve: () => resolve(e), reject }));
    return { send, calls };
  }

  function make(send: (e: Payload) => Promise<Payload>, online = true) {
    const seen: string[][] = [];
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send,
      isRejected,
      kv: memoryKV(),
      isOnline: () => online,
      onVisibleChange: (list) => seen.push(list.map((e) => e.id)),
    });
    return { outbox, seen };
  }

  it('a sync that completes under the delay never shows the line', async () => {
    const { send, calls } = controlledSend();
    const { outbox, seen } = make(send);
    outbox.add(p('a'));
    expect(outbox.pending()).toHaveLength(1); // queued...
    expect(outbox.visiblePending()).toEqual([]); // ...but not shown
    await vi.advanceTimersByTimeAsync(300);
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000); // the cancelled show-timer must not fire late
    expect(outbox.visiblePending()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('a sync still pending past the delay shows the line', async () => {
    const { send } = controlledSend();
    const { outbox, seen } = make(send);
    outbox.add(p('a'));
    await vi.advanceTimersByTimeAsync(799);
    expect(outbox.visiblePending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(outbox.visiblePending().map((e) => e.id)).toEqual(['a']);
    expect(seen).toEqual([['a']]);
  });

  it('honours a custom visibleDelayMs', async () => {
    const { send } = controlledSend();
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send,
      isRejected,
      kv: memoryKV(),
      isOnline: () => true,
      visibleDelayMs: 2000,
    });
    outbox.add(p('a'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(outbox.visiblePending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(outbox.visiblePending()).toHaveLength(1);
  });

  it('an add while offline shows the line immediately', () => {
    const { send } = controlledSend();
    const { outbox, seen } = make(send, false);
    outbox.add(p('a'));
    expect(outbox.visiblePending().map((e) => e.id)).toEqual(['a']);
    expect(seen).toEqual([['a']]);
  });

  it('once showing, it tracks the queue, and hides immediately when the queue empties', async () => {
    const { send, calls } = controlledSend();
    const { outbox, seen } = make(send);
    outbox.add(p('a'));
    await vi.advanceTimersByTimeAsync(800);
    outbox.add(p('b')); // joins the queue behind the in-flight flush
    expect(outbox.visiblePending().map((e) => e.id)).toEqual(['a', 'b']);
    calls[0].resolve(); // 'a' lands; the flush leaves 'b' queued
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.visiblePending().map((e) => e.id)).toEqual(['b']);
    const flushed = outbox.flush();
    calls[1].resolve();
    await flushed;
    // Empty queue → hidden at once, no delay.
    expect(outbox.pending()).toEqual([]);
    expect(outbox.visiblePending()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
  });

  it('leaves the raw queue and its onChange untouched by the delay', async () => {
    const { send } = controlledSend();
    const changes: number[] = [];
    const outbox = createOutbox<Payload, Payload>({
      key: KEY,
      send,
      isRejected,
      kv: memoryKV(),
      isOnline: () => true,
      onChange: (list) => changes.push(list.length),
    });
    outbox.add(p('a'));
    expect(changes).toEqual([1]);
    expect(outbox.pending()).toHaveLength(1);
  });
});
