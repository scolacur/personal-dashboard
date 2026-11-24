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

/**
 * Collapse set-state entries that supersede each other: keep only the latest entry per key,
 * preserving first-seen order among the survivors. For a queue of idempotent, last-write-wins
 * messages (e.g. "habit X on day D is done/not done"), earlier entries for the same subject are
 * redundant once a later one exists, so there is no point sending them. Used by the habit outbox
 * to collapse per `(item, day)` before a flush (PD-736 / this ticket).
 */
export function collapseByKey<T>(list: T[], key: (entry: T) => string): T[] {
  const result: T[] = [];
  const indexByKey = new Map<string, number>();
  for (const entry of list) {
    const k = key(entry);
    const at = indexByKey.get(k);
    if (at === undefined) {
      indexByKey.set(k, result.length);
      result.push(entry);
    } else {
      result[at] = entry; // same subject seen again → the later value wins, in place
    }
  }
  return result;
}

/** How long between unprompted flush attempts while entries are pending. */
export const OUTBOX_RETRY_MS = 20_000;

/**
 * How long entries must sit in the queue before the *visible* pending signal shows them (PD-778).
 * A normal online round-trip finishes well under this, so a healthy tick never flashes the
 * "N pending sync" line; only a sync that is genuinely lagging does.
 */
export const OUTBOX_VISIBLE_DELAY_MS = 800;

function defaultIsOnline(): boolean {
  // Unknown (no navigator, e.g. server-side) counts as online: only a definite `false` is offline.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export interface OutboxOptions<T, S> {
  /** localStorage key the queue persists under. Keep it stable across deploys or pending writes are orphaned. */
  key: string;
  /** Sends one entry; resolves with the server's record, throws to signal failure. */
  send: (entry: T) => Promise<S>;
  /** True for an error that means "the server refused this" (4xx) — such entries are dropped, not retried. */
  isRejected: (error: unknown) => boolean;
  /**
   * Optional subject key. When present, `add` and `start` collapse the queue so only the latest
   * entry per key survives (see {@link collapseByKey}). Omit it for append-only queues (Tinnitus,
   * whose entries each carry a unique client id and never supersede one another).
   */
  collapseKey?: (entry: T) => string;
  /** Fires whenever the pending list changes, so a component can mirror it into reactive state. */
  onChange?: (pending: T[]) => void;
  /**
   * Fires whenever the *visible* pending list changes (see {@link Outbox.visiblePending}) — the
   * signal a "N pending sync" indicator should render from, so a fast sync never flashes it (PD-778).
   */
  onVisibleChange?: (pending: T[]) => void;
  /** How long the queue must stay non-empty before it becomes visible (ms). Defaults to {@link OUTBOX_VISIBLE_DELAY_MS}. */
  visibleDelayMs?: number;
  /**
   * Whether the device is online. When it reports offline at the moment an entry is added, the
   * visible signal shows at once instead of after the delay. Defaults to `navigator.onLine`;
   * injectable for tests.
   */
  isOnline?: () => boolean;
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
  /**
   * The pending entries as an indicator should show them (also delivered via `onVisibleChange`):
   * empty until the queue has been non-empty for `visibleDelayMs`, or at once if an entry is added
   * while offline; cleared immediately when the queue empties. Indicator-only — `pending()` stays
   * the source of truth for the queue itself (PD-778).
   */
  visiblePending(): T[];
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
  const visibleDelayMs = opts.visibleDelayMs ?? OUTBOX_VISIBLE_DELAY_MS;
  const isOnline = opts.isOnline ?? defaultIsOnline;
  let pending: T[] = [];
  let flushing = false;
  let visible: T[] = [];
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelShow(): void {
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = null;
  }

  function setVisible(next: T[]): void {
    if (visible.length === 0 && next.length === 0) return; // still hidden: nothing to report
    visible = next;
    opts.onVisibleChange?.(visible);
  }

  /**
   * Recompute the visible signal from `pending`. Hide is immediate; show waits `visibleDelayMs`
   * unless `showNow` (offline at add time) or it is already showing (then it just tracks the queue).
   * Timers need a browser: without `window` there is nothing to delay for, so show at once.
   */
  function syncVisible(showNow: boolean): void {
    if (pending.length === 0) {
      cancelShow();
      setVisible([]);
      return;
    }
    if (showNow || visible.length > 0 || visibleDelayMs <= 0 || typeof window === 'undefined') {
      cancelShow();
      setVisible(pending);
      return;
    }
    showTimer ??= setTimeout(() => {
      showTimer = null;
      if (pending.length > 0) setVisible(pending);
    }, visibleDelayMs);
  }

  function setPending(next: T[], showNow = false): void {
    pending = next;
    saveQueue(opts.key, pending, kv);
    opts.onChange?.(pending);
    syncVisible(showNow);
  }

  function collapse(list: T[]): T[] {
    return opts.collapseKey ? collapseByKey(list, opts.collapseKey) : list;
  }

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const snapshot = pending;
    try {
      const r = await flushQueue(snapshot, opts.send, opts.isRejected);
      // Entries added while the flush was in flight are whatever is in `pending` now that wasn't in
      // the snapshot (by identity — a positional slice is wrong once `collapse` can rewrite the
      // queue's prefix). Keep the failed tail, then those, then collapse so a just-added write for a
      // subject supersedes its stale, already-sent snapshot entry.
      const inSnapshot = new Set<T>(snapshot);
      const added = pending.filter((e) => !inSnapshot.has(e));
      setPending(collapse([...r.remaining, ...added]));
      if (r.sent.length > 0) opts.onSent?.(r.sent);
      for (const { entry, message } of r.rejected) opts.onRejected?.(entry, message);
    } finally {
      flushing = false;
    }
  }

  function add(entry: T): void {
    setPending(collapse([...pending, entry]), !isOnline());
    void flush();
  }

  function start(): () => void {
    pending = collapse(loadQueue<T>(opts.key, kv));
    opts.onChange?.(pending);
    // Leftovers from an earlier page load get the same rule as a fresh add: shown after the delay
    // if the flush that follows `start` hasn't cleared them, or at once when offline.
    syncVisible(pending.length > 0 && !isOnline());

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
      cancelShow();
    };
  }

  return { pending: () => pending, visiblePending: () => visible, add, flush, start };
}
