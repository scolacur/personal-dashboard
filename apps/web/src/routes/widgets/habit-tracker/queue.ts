import { setCompletion, setMetricValue } from './api';

/**
 * Habit Tracker payload concerns for the shared offline outbox (`$lib/outbox`, D-093; this ticket).
 *
 * Every Habit Tracker write is a **set-state** message — "item X on day D is done / not done", or
 * "metric M on day D = value / cleared" (PROJECT.md §4). That makes replays idempotent and
 * last-write-wins: the server ends at whatever the final message for an `(item, day)` says, no
 * matter how many superseded ones preceded it. So the outbox collapses pending writes per
 * `(item, day)` before sending — see {@link pendingKey} and the outbox's `collapseKey`.
 *
 * The outbox mechanics (localStorage persistence, the flush loop, the retry triggers, the pending
 * count) live in `$lib/outbox`. What's here is Habit-specific: the payload type, the subject key the
 * collapse groups on, and the dispatcher that turns one payload into its API call.
 */

/** The storage key for pending Habit Tracker writes. Keep it stable across deploys or queued writes are orphaned. */
export const QUEUE_KEY = 'habit-tracker:pending';

/** A completion set-state: habit `itemId` on habit day `day` is done, or not. */
export interface PendingCompletion {
  kind: 'completion';
  itemId: number;
  day: string;
  done: boolean;
}

/** A metric set-state: metric `itemId` on habit day `day` has `value` (a logged value, or null = cleared). */
export interface PendingMetric {
  kind: 'metric';
  itemId: number;
  day: string;
  value: string | null;
}

export type PendingHabitWrite = PendingCompletion | PendingMetric;

/**
 * The subject a write targets: one `(item, day)` cell. Two writes with the same key supersede each
 * other (last wins), which is exactly what the outbox collapses on. A completion and a metric can
 * never share an item (an item is one kind or the other), so the key needs no `kind`.
 */
export function pendingKey(entry: PendingHabitWrite): string {
  return `${entry.itemId}:${entry.day}`;
}

/** Send one queued write. The outbox calls this oldest-first; each is idempotent (set-state). */
export async function sendHabitWrite(entry: PendingHabitWrite): Promise<void> {
  if (entry.kind === 'completion') {
    await setCompletion(entry.itemId, entry.day, entry.done);
  } else {
    await setMetricValue(entry.itemId, entry.day, entry.value);
  }
}

/**
 * Fold pending completion writes for `day` over the server's done-set, so a fresh load reflects an
 * unsynced tick instead of visually reverting it (PROJECT.md §4). The pending list is applied in
 * order, so a later write for an `(item, day)` wins — the same last-write-wins the server will
 * reach once the queue flushes. Metric and other-day entries are ignored here; the caller folds
 * metric values into its own state.
 */
export function applyPendingCompletions(
  serverDone: Iterable<number>,
  pending: PendingHabitWrite[],
  day: string,
): Set<number> {
  const done = new Set<number>(serverDone);
  for (const entry of pending) {
    if (entry.kind !== 'completion' || entry.day !== day) continue;
    if (entry.done) done.add(entry.itemId);
    else done.delete(entry.itemId);
  }
  return done;
}

/**
 * Fold pending metric writes for `day` over the server's values (itemId → value, null = cleared), so
 * an unsynced metric value survives a reload instead of reverting (PROJECT.md §4). Applied in order,
 * last write wins — the same end state the server reaches once the queue flushes. Completion and
 * other-day entries are ignored.
 */
export function applyPendingMetrics(
  serverValues: Iterable<readonly [number, string | null]>,
  pending: PendingHabitWrite[],
  day: string,
): Map<number, string | null> {
  const values = new Map<number, string | null>(serverValues);
  for (const entry of pending) {
    if (entry.kind !== 'metric' || entry.day !== day) continue;
    values.set(entry.itemId, entry.value);
  }
  return values;
}
