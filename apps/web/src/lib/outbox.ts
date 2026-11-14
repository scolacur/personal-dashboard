/**
 * A generic offline outbox for widget writes (PD-736).
 *
 * Extracted from the Tinnitus Tracker's queue so a second widget — the Habit Tracker
 * (PD-361, `widgets/habit-tracker/PROJECT.md` §4) — can reuse it without importing another
 * widget's folder (PROJECT.md §5 forbids widget-to-widget imports and routes shared client
 * code here).
 *
 * The outbox owns the mechanics only — localStorage persistence (per-key), the oldest-first
 * flush loop, the retry triggers (on `online`, on tab focus, every 20 s) and the pending count.
 * The payload type `T`, the `send` function and the 4xx-vs-unreachable classification are the
 * caller's: the outbox never looks inside a payload.
 *
 * Every write should go through it, online or not: `add` appends to the queue, then the queue
 * flushes. That way there is one code path, and a write made with no signal keeps its real
 * timestamp until the server can be reached. Replays are the caller's problem to make safe
 * (e.g. a server idempotent on some client id).
 *
 * Storage is the device's localStorage. It is per-device and can be cleared, which is acceptable
 * for a short-lived outbox but not for the durable record itself.
 */

/** The slice of the Storage API the outbox needs; injectable for tests. */
export type OutboxStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): OutboxStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadQueue<T>(key: string, kv: OutboxStorage | null = defaultStorage()): T[] {
  try {
    const raw = kv?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveQueue<T>(key: string, list: T[], kv: OutboxStorage | null = defaultStorage()): void {
  try {
    kv?.setItem(key, JSON.stringify(list));
  } catch {
    // Storage full or blocked. The in-memory list still holds the entries for this page load.
  }
}

export interface FlushResult<T, S> {
  sent: S[];
  /** Entries the server refused (4xx). Dropped from the queue, because a retry would fail the same way. */
  rejected: { entry: T; message: string }[];
  /** Still queued: the first entry that hit an unreachable server, plus everything after it. */
  remaining: T[];
}

/**
 * Send queued entries oldest-first. Stops at the first unreachable failure: if one can't get
 * through, the rest won't either, so there is no point hammering a dead link. An error for which
 * `isRejected` returns true is dropped (the server refused it); any other error keeps the entry
 * queued rather than lose a write.
 */
export async function flushQueue<T, S>(
  list: T[],
  send: (entry: T) => Promise<S>,
  isRejected: (error: unknown) => boolean,
): Promise<FlushResult<T, S>> {
  const result: FlushResult<T, S> = { sent: [], rejected: [], remaining: [] };
  for (let i = 0; i < list.length; i++) {
    try {
      result.sent.push(await send(list[i]));
    } catch (e) {
      if (isRejected(e)) {
        result.rejected.push({ entry: list[i], message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      // Unreachable, or anything unexpected: keep it queued rather than lose a write.
      result.remaining = list.slice(i);
      break;
    }
  }
  return result;
}

/** How long between unprompted flush attempts while entries are pending. */
export const OUTBOX_RETRY_MS = 20_000;

export interface OutboxOptions<T, S> {
  /** localStorage key the queue persists under. Keep it stable across deploys or pending writes are orphaned. */
  key: string;
  /** Sends one entry; resolves with the server's record, throws to signal failure. */
  send: (entry: T) => Promise<S>;
  /** True for an error that means "the server refused this" (4xx) — such entries are dropped, not retried. */
  isRejected: (error: unknown) => boolean;
  /** Fires whenever the pending list changes, so a component can mirror it into reactive state. */
  onChange?: (pending: T[]) => void;
  /** Fires with the entries a flush got through, for the caller to fold into its view. */
  onSent?: (sent: S[]) => void;
  /** Fires per entry the server refused, so the caller can surface it. */
  onRejected?: (entry: T, message: string) => void;
  /** Override the retry interval (ms). Defaults to {@link OUTBOX_RETRY_MS}. */
  retryMs?: number;
  /** Storage override, for tests. Defaults to the device's localStorage. */
  kv?: OutboxStorage | null;
}

export interface Outbox<T> {
  /** The current pending entries (also delivered via `onChange`). */
  pending(): T[];
  /** Queue an entry, persist, and kick a flush. */
  add(entry: T): void;
  /** Send everything queued, oldest-first. Re-entrant-safe: a second call while one is in flight is a no-op. */
  flush(): Promise<void>;
  /** Load any persisted queue and wire the retry triggers. Returns a teardown for `onMount`. */
  start(): () => void;
}

/**
 * Create an outbox bound to one storage key and send function. The caller owns reactivity: pass
 * `onChange` and copy the list into component state (e.g. a Svelte `$state`) — the outbox itself
 * is plain (not a `.svelte.ts` store) so its logic stays unit-testable without the Svelte
 * compiler. See D-093.
 */
export function createOutbox<T, S>(opts: OutboxOptions<T, S>): Outbox<T> {
  const kv = opts.kv === undefined ? defaultStorage() : opts.kv;
  const retryMs = opts.retryMs ?? OUTBOX_RETRY_MS;
  let pending: T[] = [];
  let flushing = false;

  function setPending(next: T[]): void {
    pending = next;
    saveQueue(opts.key, pending, kv);
    opts.onChange?.(pending);
  }

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const snapshot = pending;
    try {
      const r = await flushQueue(snapshot, opts.send, opts.isRejected);
      // Anything added while the flush was in flight was appended after the snapshot; keep it.
      setPending([...r.remaining, ...pending.slice(snapshot.length)]);
      if (r.sent.length > 0) opts.onSent?.(r.sent);
      for (const { entry, message } of r.rejected) opts.onRejected?.(entry, message);
    } finally {
      flushing = false;
    }
  }

  function add(entry: T): void {
    setPending([...pending, entry]);
    void flush();
  }

  function start(): () => void {
    pending = loadQueue<T>(opts.key, kv);
    opts.onChange?.(pending);

    // The retry triggers need a browser. `onMount` only fires client-side, but guard anyway so the
    // module is safe to construct and load from anywhere (and unit-testable without a DOM).
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

    const retry = () => void flush();
    const onVisible = () => document.visibilityState === 'visible' && retry();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => pending.length > 0 && retry(), retryMs);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }

  return { pending: () => pending, add, flush, start };
}
