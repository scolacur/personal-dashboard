import type { CreateTinnitusEntryInput, TinnitusEntry } from '@dashboard/shared';
import { RejectedError } from './api';

/**
 * The offline queue for Tinnitus Tracker entries.
 *
 * Every entry goes through it, online or not: Enter appends to the queue, then the queue flushes.
 * That way there is one code path, and an entry made with no signal (subway, plane) keeps its real
 * timestamp until the server can be reached. Replays are safe because the server is idempotent
 * on `clientId`.
 *
 * Storage is the phone's localStorage. It is per-device and can be cleared, which is acceptable
 * for a short-lived outbox but would not be for the log itself. The log lives in SQLite.
 */

export const QUEUE_KEY = 'tinnitus-tracker:pending';

export type PendingEntry = CreateTinnitusEntryInput;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPending(kv: KV | null = storage()): PendingEntry[] {
  try {
    const raw = kv?.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

export function savePending(list: PendingEntry[], kv: KV | null = storage()): void {
  try {
    kv?.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked. The in-memory list still holds the entries for this page load.
  }
}

export interface FlushResult {
  sent: TinnitusEntry[];
  /** Entries the server refused (4xx). Dropped from the queue, because a retry would fail the same way. */
  rejected: { entry: PendingEntry; message: string }[];
  /** Still queued: the first entry that hit an unreachable server, plus everything after it. */
  remaining: PendingEntry[];
}

/**
 * Send queued entries oldest-first. Stops at the first unreachable failure: if one can't get
 * through, the rest won't either, so there is no point hammering a dead link.
 */
export async function flushPending(
  list: PendingEntry[],
  send: (e: PendingEntry) => Promise<TinnitusEntry>,
): Promise<FlushResult> {
  const result: FlushResult = { sent: [], rejected: [], remaining: [] };
  for (let i = 0; i < list.length; i++) {
    try {
      result.sent.push(await send(list[i]));
    } catch (e) {
      if (e instanceof RejectedError) {
        result.rejected.push({ entry: list[i], message: e.message });
        continue;
      }
      // UnreachableError, or anything unexpected: keep it queued rather than lose a reading.
      result.remaining = list.slice(i);
      break;
    }
  }
  return result;
}

/**
 * A unique id for an entry. `crypto.randomUUID` only exists in a secure context, and the dashboard
 * is served over plain http on the LAN and tailnet. On a phone it is often undefined, so this falls
 * back to time plus randomness, which is plenty for one person's log.
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
